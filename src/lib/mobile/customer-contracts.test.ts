import { describe, expect, it } from "vitest";

import { APP_SERVICE_BOUNDARY_VERSION } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { customerAccountListServiceInputSchema } from "@/lib/app-services/customer-accounts";
import { buildCustomerAccountRevision, buildCustomerFactRevision, projectCustomerAccount360, customerAccountId, customerFactId, customerMutationId, type CustomerFactValue } from "@/lib/customer-success/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { nativeCustomerListQuerySchema, nativeCustomerListResponseForScopeSchema, nativeCustomerListResponseSchema, nativeCustomerReadResponseForScopeSchema, nativeCustomerReadResponseSchema, nativeCustomerPortfolioResponseForScopeSchema, nativeCustomerPortfolioResponseSchema, nativeCustomerContractSchemas } from "./customer-contracts";

const now = "2026-10-04T10:00:00.000Z", tenantId = "tenant-a", workspaceId = "workspace:tenant-a", actor = "actor:11111111-1111-4111-8111-111111111111";
const scope = { tenantId, workspaceId, requestActorId: "reader@example.test", role: "viewer" };
const context = { scope: "workspace", workspaceId, accessLevel: "reader", canWrite: false, authoritySha256: "a".repeat(64) };
function account(key = "one") {
  const id = customerAccountId({ tenantId, workspaceId, idempotencyKey: key });
  return buildCustomerAccountRevision({ tenantId, workspaceId, accountId: id, revision: 1, mutationId: customerMutationId({ accountId: id, idempotencyKey: key, operation: "account.create" }), name: "Customer <script>text only</script>", lifecycle: "active", organizationEntityId: null,
    accountOwner: { ownerKind: "actor", ownerId: actor, displayName: "A different workspace member" }, crmPermissions: { readScope: "workspace_members", writeScope: "account_owner", externalWriteState: "disabled", customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] }, ownerActorId: actor, revisedByActorId: actor, revisedAt: now });
}
function fact(key = "one", value: CustomerFactValue = { kind: "risk", entityId: "risk:one", title: "Competing evidence", severity: "high", status: "open" }) {
  const accountId = account().accountId;
  return buildCustomerFactRevision({ tenantId, workspaceId, accountId, factId: customerFactId({ accountId, idempotencyKey: key }), revision: 1, mutationId: customerMutationId({ accountId, idempotencyKey: key, operation: "fact.record" }), factKey: "risk.one", value,
    source: { sourceKind: "manual", sourceId: "source:one", sourceRevisionId: "source:one:v1", sourceRevisionSha256: "b".repeat(64), sourceLabel: "Exact source", providerId: null, providerObjectType: null, providerObjectIdSha256: null, permissionBasis: "operator_assertion", allowedPurposeIds: ["customer_success.account.read"], observedAt: now, ingestedAt: now }, owner: { ownerKind: "actor", ownerId: actor, displayName: "Other member" }, confidenceBasisPoints: 8000, validFrom: now, staleAfter: null, recordedByActorId: actor, recordedAt: now });
}
function response<T extends object>(data: T, operation: Parameters<typeof getAppServiceOperationContract>[0], count: number) {
  const contract = getAppServiceOperationContract(operation);
  const receipt = { schemaVersion: 1, receiptKind: "app_service_receipt", boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, operation, action: contract.action, resourceType: contract.resourceType, accessMode: "read", eventContract: contract.eventContract, authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId, actorId: scope.requestActorId, role: scope.role, executionScope: null }), idempotencyKeySha256: null, outcomeSha256: canonicalJsonSha256(data), resourceCount: count, occurredAt: now };
  return { ...data, serviceReceipt: { ...receipt, receiptSha256: canonicalJsonSha256(receipt) } };
}
function detail() { return { context, account: projectCustomerAccount360({ account: account(), currentFacts: [fact(), fact("two", { kind: "risk", entityId: "risk:one", title: "Other claim", severity: "high", status: "resolved" })], historyCount: 3, evaluatedAt: now }) }; }
function portfolio() {
  const accountValue = account();
  const recommendation = { policyVersion: "p10.14-customer-success-intelligence:1", recommendationId: `customer-success-recommendation:${"c".repeat(64)}`, action: "monitor_account", workflowId: null, title: "Review evidence", reason: "No score is a healthy-status claim.", confidenceBasisPoints: 0, uncertainty: ["No current evaluation"], evidence: [{ kind: "account_revision", refId: accountValue.accountId, revisionId: accountValue.revisionId, sha256: accountValue.accountSha256, observedAt: now, label: "Account" }], freshness: { status: "unknown", oldestObservedAt: null, evaluatedAt: now }, authoritative: false, suggested: true, generatedAt: now };
  const body = { policyVersion: "p10.14-customer-success-intelligence:1", generatedAt: now, accounts: [{ accountId: accountValue.accountId, accountRevisionId: accountValue.revisionId, accountSha256: accountValue.accountSha256, name: accountValue.name, lifecycle: accountValue.lifecycle, ownerName: "Other member", attention: "unknown", health: { status: "unknown", scoreBasisPoints: null, confidenceBasisPoints: 0, coverageBasisPoints: 0, current: false, evaluatedAt: null }, counts: { openRisks: 0, criticalRisks: 0, openCommitments: 0, overdueCommitments: 0, pendingApprovals: 0, staleFacts: 0, conflicts: 0 }, nextBestAction: { ...recommendation, recommendationSha256: canonicalJsonSha256(recommendation) }, changedAt: now }], counts: { total: 1, urgent: 0, attention: 0, pendingApprovals: 0, overdueCommitments: 0 } };
  return { context, portfolio: { ...body, projectionSha256: canonicalJsonSha256(body) } };
}
describe("standalone native Customer read candidates", () => {
  it("publishes no mutation or arbitrary object fallback", () => {
    expect(Object.keys(nativeCustomerContractSchemas)).toEqual(["NativeCustomerListQuery", "NativeCustomerPortfolioQuery", "NativeCustomerReadQuery", "NativeCustomerContext", "NativeCustomerListResponse", "NativeCustomerPortfolioResponse", "NativeCustomerReadResponse"]);
  });
  it.each([{}, { limit: 1 }, { limit: 200, lifecycle: "active" }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { arbitrary: true }])("matches current bounded list input: %j", (query) => {
    expect(nativeCustomerListQuerySchema.safeParse(query).success).toBe(customerAccountListServiceInputSchema.safeParse(query).success);
  });
  it("retains workspace-readable accounts owned by a different member", () => {
    const value = response({ context, accounts: [account()] }, "app.customer_accounts.list", 1);
    expect(nativeCustomerListResponseForScopeSchema(scope).parse(value).accounts[0].ownerActorId).toBe(actor);
    for (const changed of [{ tenantId: "other" }, { requestActorId: "other@example.test" }, { role: "admin" }, { workspaceId: "workspace:other" }]) expect(nativeCustomerListResponseForScopeSchema({ ...scope, ...changed }).safeParse(value).success).toBe(false);
  });
  it("bounds list rows, forbids duplicates and checks counts", () => {
    const rows = Array.from({ length: 200 }, (_, index) => account(String(index)));
    expect(nativeCustomerListResponseSchema.safeParse(response({ context, accounts: rows }, "app.customer_accounts.list", 200)).success).toBe(true);
    expect(nativeCustomerListResponseSchema.safeParse(response({ context, accounts: [...rows, account("201")] }, "app.customer_accounts.list", 201)).success).toBe(false);
    expect(nativeCustomerListResponseSchema.safeParse(response({ context, accounts: [account(), account()] }, "app.customer_accounts.list", 2)).success).toBe(false);
    expect(nativeCustomerListResponseSchema.safeParse(response({ context, accounts: [account()] }, "app.customer_accounts.list", 0)).success).toBe(false);
  });
  it("keeps conflicting exact facts and the complete kind index", () => {
    const value = response(detail(), "app.customer_accounts.show", 1);
    expect(nativeCustomerReadResponseForScopeSchema({ ...scope, accountId: account().accountId }).parse(value).account.conflictCount).toBe(2);
    expect(nativeCustomerReadResponseForScopeSchema({ ...scope, accountId: account("other").accountId }).safeParse(value).success).toBe(false);
    const body = detail(); body.account.factsByKind.risk = [];
    expect(nativeCustomerReadResponseSchema.safeParse(response(body, "app.customer_accounts.show", 1)).success).toBe(false);
  });
  it("rejects re-signed foreign facts and invented conflict resolution", () => {
    const body = detail(), row = body.account.facts[0].fact;
    row.tenantId = "foreign"; const { factSha256: _hash, ...rest } = row; row.factSha256 = canonicalJsonSha256(rest);
    expect(nativeCustomerReadResponseSchema.safeParse(response(body, "app.customer_accounts.show", 1)).success).toBe(false);
    const hidden = detail(); hidden.account.facts[0].conflict = { state: "none", conflictingFactIds: [] };
    expect(nativeCustomerReadResponseSchema.safeParse(response(hidden, "app.customer_accounts.show", 1)).success).toBe(false);
  });
  it("rejects nested extra fields, incorrect operation and body/receipt substitution", () => {
    const value = response({ context, accounts: [account()] }, "app.customer_accounts.list", 1);
    expect(nativeCustomerListResponseSchema.safeParse({ ...value, extra: true }).success).toBe(false);
    expect(nativeCustomerListResponseSchema.safeParse(response({ context: { ...context, injected: true }, accounts: [account()] }, "app.customer_accounts.list", 1)).success).toBe(false);
    expect(nativeCustomerListResponseSchema.safeParse(response({ context, accounts: [account()] }, "app.customer_accounts.show", 1)).success).toBe(false);
    value.accounts[0].name = "Substituted";
    expect(nativeCustomerListResponseSchema.safeParse(value).success).toBe(false);
  });
  it("binds unknown health and non-authoritative suggestions to exact portfolio receipt", () => {
    const value = response(portfolio(), "app.customer_accounts.portfolio.show", 1);
    expect(nativeCustomerPortfolioResponseForScopeSchema(scope).parse(value).portfolio.accounts[0].health.scoreBasisPoints).toBeNull();
    expect(nativeCustomerPortfolioResponseForScopeSchema({ ...scope, role: "admin" }).safeParse(value).success).toBe(false);
    const invalid = portfolio(); invalid.portfolio.accounts[0].nextBestAction.authoritative = true;
    expect(nativeCustomerPortfolioResponseSchema.safeParse(response(invalid, "app.customer_accounts.portfolio.show", 1)).success).toBe(false);
  });
});
