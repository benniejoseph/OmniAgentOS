import { describe, expect, it } from "vitest";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptBodySchema } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { buildCustomerAccountMutationAcceptance, buildCustomerAccountMutationIntent, customerAccountMutationRequestSchema } from "@/lib/customer-success/account-mutation-contracts";
import { buildCustomerAccountRevision } from "@/lib/customer-success/contracts";
import { nativeCustomerCreateRequestSchema, nativeCustomerCreateResponseSchema, nativeCustomerMutationResponseForScopeSchema, nativeCustomerReviseRequestSchema, type NativeCustomerMutationScope } from "@/lib/mobile/customer-mutation-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const actor = "actor:11111111-1111-4111-8111-111111111111", tenant = "tenant-account", workspace = "workspace:account";
const owner = { ownerKind: "actor" as const, ownerId: actor, displayName: "Owner" };
function fixture(operation: "account.create" | "account.revise" = "account.create") {
  const request = customerAccountMutationRequestSchema.parse(operation === "account.create" ? { operation, name: "Acme", accountOwner: owner } : { operation, expectedRevision: 4, lifecycle: "at_risk" });
  const scope: NativeCustomerMutationScope = { tenantId: tenant, workspaceId: workspace, canonicalActorId: actor, requestActorId: "owner@example.test", role: "admin", idempotencyKey: "exact-account-key", accountId: operation === "account.revise" ? `customer-account:${"a".repeat(64)}` : undefined, request,
    executionScope: createExecutionScope({ tenantId: tenant, initiatingActorId: "owner@example.test", executingPrincipalType: "user", executingPrincipalId: "owner@example.test", workspaceId: workspace, correlationId: "exact-account-key", purpose: "api.customer-account.manage" }) };
  const intent = buildCustomerAccountMutationIntent(scope);
  const account = buildCustomerAccountRevision({ tenantId: tenant, workspaceId: workspace, accountId: intent.accountId, mutationId: intent.mutationId, revision: operation === "account.create" ? 1 : 5, name: "Acme", lifecycle: operation === "account.create" ? "prospect" : "at_risk", accountOwner: owner, crmPermissions: { readScope: "workspace_members", writeScope: "account_owner", externalWriteState: "disabled", customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] }, ownerActorId: actor, revisedByActorId: actor, revisedAt: "2026-10-04T12:00:00.000Z" });
  const body = { context: { scope: "workspace" as const, workspaceId: workspace, accessLevel: "manager" as const, canWrite: true, authoritySha256: "b".repeat(64) }, account, acceptance: buildCustomerAccountMutationAcceptance(intent, account) };
  const contract = getAppServiceOperationContract(operation === "account.create" ? "app.customer_accounts.create" : "app.customer_accounts.revise");
  const receipt = appServiceReceiptBodySchema.parse({ schemaVersion: 1, receiptKind: "app_service_receipt", boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, operation: contract.operation, action: contract.action, resourceType: contract.resourceType, accessMode: "mutation", eventContract: contract.eventContract, authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: tenant, actorId: scope.requestActorId, role: scope.role, executionScope: scope.executionScope }), idempotencyKeySha256: body.acceptance.idempotencyKeySha256, outcomeSha256: canonicalJsonSha256(body), resourceCount: 1, occurredAt: "2026-10-04T12:01:00.000Z" });
  return { scope, value: { ...body, serviceReceipt: { ...receipt, receiptSha256: canonicalJsonSha256(receipt) } } };
}
type ResponseValue = ReturnType<typeof fixture>["value"];
function resign(value: ResponseValue) {
  const { serviceReceipt, ...body } = value;
  const { receiptSha256: _receiptSha256, ...receipt } = serviceReceipt;
  receipt.outcomeSha256 = canonicalJsonSha256(body);
  return { ...body, serviceReceipt: { ...receipt, receiptSha256: canonicalJsonSha256(receipt) } };
}
describe("standalone native Account mutation candidates", () => {
  it.each(["account.create", "account.revise"] as const)("binds %s accepted fields independently of a later authorization receipt clock", (operation) => {
    const f = fixture(operation);
    expect(nativeCustomerMutationResponseForScopeSchema(f.scope).parse(f.value)).toEqual(f.value);
    expect(f.value.acceptance.acceptedAt).not.toBe(f.value.serviceReceipt.occurredAt);
  });
  it("rejects legacy or extra-field envelopes instead of asserting exact replay evidence", () => {
    const f = fixture();
    const { acceptance: _acceptance, ...legacy } = f.value;
    for (const value of [legacy, { ...f.value, replayed: true }, { ...f.value, acceptance: { ...f.value.acceptance, request: {} } }]) expect(nativeCustomerCreateResponseSchema.safeParse(value).success).toBe(false);
  });
  it.each(["requestActorId", "role", "tenantId", "workspaceId", "canonicalActorId", "idempotencyKey"] as const)("rejects a different %s even with a self-consistent envelope", (field) => {
    const f = fixture();
    const values = { requestActorId: "other@example.test", role: "operator", tenantId: "tenant-other", workspaceId: "workspace:other", canonicalActorId: "actor:22222222-2222-4222-8222-222222222222", idempotencyKey: "different-key" };
    expect(nativeCustomerMutationResponseForScopeSchema({ ...f.scope, [field]: values[field] }).safeParse(f.value).success).toBe(false);
  });
  it("rejects an old acceptance under a changed sparse patch or CAS", () => {
    const f = fixture("account.revise");
    for (const request of [
      { operation: "account.revise" as const, expectedRevision: 4, lifecycle: "at_risk" as const, name: "Acme" },
      { operation: "account.revise" as const, expectedRevision: 5, lifecycle: "at_risk" as const },
    ]) expect(nativeCustomerMutationResponseForScopeSchema({ ...f.scope, request }).safeParse(f.value).success).toBe(false);
  });
  it("rejects receipt drift, wrong accepted revision and downgraded current access", () => {
    const f = fixture();
    for (const value of [
      { ...f.value, serviceReceipt: { ...f.value.serviceReceipt, operation: "app.customer_accounts.revise" } },
      resign({ ...f.value, context: { ...f.value.context, canWrite: false } }),
      resign({ ...f.value, acceptance: { ...f.value.acceptance, revision: 2 } }),
    ]) expect(nativeCustomerCreateResponseSchema.safeParse(value).success).toBe(false);
  });
  it("bounds and strictly validates requests, with workspace excluded from the change set", () => {
    expect(nativeCustomerCreateRequestSchema.safeParse({ name: "x".repeat(241), accountOwner: owner }).success).toBe(false);
    expect(nativeCustomerReviseRequestSchema.safeParse({ workspaceId: workspace, expectedRevision: 4 }).success).toBe(false);
    expect(nativeCustomerReviseRequestSchema.safeParse({ expectedRevision: 4, lifecycle: "active", ownerActorId: actor }).success).toBe(false);
    expect(nativeCustomerReviseRequestSchema.parse({ expectedRevision: 4, organizationEntityId: null })).toEqual({ expectedRevision: 4, organizationEntityId: null });
  });
});
