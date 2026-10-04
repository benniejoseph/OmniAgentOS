import { describe, expect, it } from "vitest";
import { createAppServiceCaller, authorizeAppServiceCall, completeAppServiceCall } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { buildDefaultCustomerHealthPolicy, customerHealthScoreId } from "@/lib/customer-success/health-contracts";
import { buildCustomerHealthEvaluationIntent, customerHealthEvaluationAcceptanceSchema, customerHealthEvaluationRequestSchema } from "@/lib/customer-success/health-mutation-contracts";
import {
  nativeCustomerHealthEvaluateRequestSchema, nativeCustomerHealthEvaluateResponseSchema,
  nativeCustomerHealthEvaluateResponseForScopeSchema, nativeCustomerHealthEvaluationReadResponseForScopeSchema,
  nativeCustomerHealthEvaluationErrorSchema, nativeCustomerHealthEvaluationRefusalSchema,
} from "@/lib/mobile/customer-health-mutation-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const context = { tenantId: "tenant-health", actorId: "owner@example.test", role: "admin" as const, source: "session" as const };
const canonicalActorId = "actor:11111111-1111-4111-8111-111111111111", workspaceId = "workspace:health", accountId = `customer-account:${"a".repeat(64)}`;
function fixture() {
  const request = customerHealthEvaluationRequestSchema.parse({ contract: "customer-health-evaluation-request:1", workspaceId,
    expectedAccountRevision: 4, expectedAccountSha256: "b".repeat(64), modelSuggestions: [] });
  const scope = { tenantId: context.tenantId, canonicalActorId, workspaceId, accountId, requestActorId: context.actorId,
    role: context.role, request, idempotencyKey: "health-native-key",
    executionScope: createExecutionScope({ tenantId: context.tenantId, initiatingActorId: context.actorId,
      executingPrincipalType: "user", executingPrincipalId: context.actorId, workspaceId, correlationId: "health-native-key",
      causationId: accountId, purpose: "api.customer-health.evaluate" }) };
  const intent = buildCustomerHealthEvaluationIntent(scope), policy = buildDefaultCustomerHealthPolicy();
  const scoreId = customerHealthScoreId({ tenantId: context.tenantId, workspaceId, accountId });
  const acceptanceBody = { schemaVersion: 1 as const, contract: "customer-health-evaluation-acceptance:1" as const, operation: "health.evaluate" as const,
    tenantId: context.tenantId, workspaceId, accountId, canonicalActorId, evaluationId: intent.evaluationId,
    idempotencyKeySha256: intent.idempotencyKeySha256, requestSha256: canonicalJsonSha256(intent),
    accountRevisionId: `${accountId}:v4`, accountRevision: 4, accountSha256: request.expectedAccountSha256,
    scoreId, scoreRevisionId: `${scoreId}:v2`, scoreRevision: 2, scoreSha256: "c".repeat(64),
    policyId: policy.policyId, policySha256: policy.policySha256, inputSha256: "d".repeat(64),
    scoreBasisPoints: null, status: "unknown" as const, confidenceBasisPoints: 0, coverageBasisPoints: 0,
    authority: "deterministic_policy" as const, acceptedAt: "2026-10-04T12:00:00.123Z" };
  const acceptance = customerHealthEvaluationAcceptanceSchema.parse({ ...acceptanceBody, acceptanceSha256: canonicalJsonSha256(acceptanceBody) });
  const body = { contract: "customer-health-evaluation-read:1" as const,
    context: { scope: "workspace" as const, workspaceId, accessLevel: "manager" as const, canWrite: true, authoritySha256: "e".repeat(64) },
    currentAccount: { accountId, revisionId: `${accountId}:v4`, revision: 4, accountSha256: request.expectedAccountSha256 }, acceptance, replayed: false };
  const caller = createAppServiceCaller({ context, idempotencyKey: scope.idempotencyKey, executionScope: scope.executionScope });
  const result = completeAppServiceCall(authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.health.evaluate")), body, { resourceCount: 1 });
  return { scope, intent, value: { ...result.data, serviceReceipt: result.receipt } };
}
type Value = ReturnType<typeof fixture>["value"];
function resign(value: Value) {
  const { serviceReceipt, ...body } = value, { receiptSha256: _hash, ...receipt } = serviceReceipt;
  const next = { ...receipt, outcomeSha256: canonicalJsonSha256(body) };
  return { ...body, serviceReceipt: { ...next, receiptSha256: canonicalJsonSha256(next) } };
}
function read(value: Value, acceptance = true) {
  const { serviceReceipt: _receipt, replayed: _replayed, ...original } = value;
  const body = { ...original, acceptance: acceptance ? original.acceptance : null,
    context: { ...original.context, accessLevel: "reader" as const, canWrite: false } };
  const caller = createAppServiceCaller({ context: { ...context, role: "viewer" } });
  const result = completeAppServiceCall(authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.health.evaluations.show")), body, { resourceCount: acceptance ? 1 : 0 });
  return { ...result.data, serviceReceipt: result.receipt };
}
describe("compact native Account health evaluation boundary", () => {
  it("binds the deterministic compact receipt to the exact frozen request and current caller", () => {
    const f = fixture();
    expect(nativeCustomerHealthEvaluateResponseForScopeSchema(f.scope).parse(f.value)).toEqual(f.value);
    expect(f.value.serviceReceipt.idempotencyKeySha256).toBe(f.value.acceptance.idempotencyKeySha256);
    expect(JSON.stringify(f.value).length).toBeLessThan(10_000);
    expect(nativeCustomerHealthEvaluateResponseSchema.safeParse({ ...f.value, score: {} }).success).toBe(false);
  });
  it("requires an explicit workspace, empty suggestions and SQL-bounded reviewed revision", () => {
    const request = fixture().scope.request;
    for (const invalid of [{ ...request, workspaceId: undefined }, { ...request, modelSuggestions: undefined },
      { ...request, modelSuggestions: [{}] }, { ...request, expectedAccountRevision: 2_147_483_648 },
      { ...request, accountId }, { ...request, contract: "legacy" }]) {
      expect(nativeCustomerHealthEvaluateRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("allows later account revisions on replay and exact recovery, but never rollback or equal-revision hash drift", () => {
    const f = fixture(), later = resign({ ...f.value, replayed: true,
      currentAccount: { ...f.value.currentAccount, revision: 5, revisionId: `${accountId}:v5`, accountSha256: "f".repeat(64) } });
    expect(nativeCustomerHealthEvaluateResponseForScopeSchema(f.scope).parse(later).currentAccount.revision).toBe(5);
    const readScope = { ...f.scope, evaluationId: f.intent.evaluationId, role: "viewer" };
    expect(nativeCustomerHealthEvaluationReadResponseForScopeSchema(readScope).parse(read(later)).acceptance).toEqual(f.value.acceptance);
    expect(nativeCustomerHealthEvaluationReadResponseForScopeSchema(readScope).parse(read(later, false)).acceptance).toBeNull();
    for (const invalid of [resign({ ...later, replayed: false }),
      resign({ ...f.value, currentAccount: { ...f.value.currentAccount, revision: 3, revisionId: `${accountId}:v3` } }),
      resign({ ...f.value, currentAccount: { ...f.value.currentAccount, accountSha256: "f".repeat(64) } })]) {
      expect(nativeCustomerHealthEvaluateResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it.each(["tenantId", "workspaceId", "canonicalActorId", "requestActorId", "role", "idempotencyKey"] as const)("rejects a changed %s even with a self-consistent receipt", (field) => {
    const f = fixture(), changed = { tenantId: "tenant-other", workspaceId: "workspace:other",
      canonicalActorId: "actor:22222222-2222-4222-8222-222222222222", requestActorId: "other@example.test", role: "operator", idempotencyKey: "other-key" };
    const scope = { ...f.scope, [field]: changed[field] };
    if (field === "workspaceId") scope.request = { ...scope.request, workspaceId: changed.workspaceId };
    expect(nativeCustomerHealthEvaluateResponseForScopeSchema(scope).safeParse(f.value).success).toBe(false);
  });
  it("rejects changed request pins, scope purpose, response count and receipt digest", () => {
    const f = fixture();
    expect(nativeCustomerHealthEvaluateResponseForScopeSchema({ ...f.scope, request: { ...f.scope.request, expectedAccountRevision: 5 } }).safeParse(f.value).success).toBe(false);
    expect(nativeCustomerHealthEvaluateResponseForScopeSchema({ ...f.scope, executionScope: { ...f.scope.executionScope, purpose: "different" } }).safeParse(f.value).success).toBe(false);
    expect(nativeCustomerHealthEvaluateResponseSchema.safeParse(resign({ ...f.value, serviceReceipt: { ...f.value.serviceReceipt, resourceCount: 0 } })).success).toBe(false);
    expect(nativeCustomerHealthEvaluateResponseSchema.safeParse({ ...f.value, serviceReceipt: { ...f.value.serviceReceipt, receiptSha256: "0".repeat(64) } }).success).toBe(false);
  });
  it("keeps exact no-admission proof distinct from generic failures", () => {
    const f = fixture(), proof = { contract: "customer-health-evaluation-refusal:1", error: "Account changed.",
      code: "customer_health_account_changed", admission: "not_admitted", evaluationId: f.intent.evaluationId, requestSha256: canonicalJsonSha256(f.intent) };
    expect(nativeCustomerHealthEvaluationRefusalSchema.parse(proof)).toEqual(proof);
    expect(nativeCustomerHealthEvaluationErrorSchema.parse({ error: "Invalid request", message: "Missing key" })).not.toHaveProperty("admission");
    expect(nativeCustomerHealthEvaluationErrorSchema.safeParse({ ...proof, code: "customer_health_intent_conflict" }).success).toBe(false);
    expect(nativeCustomerHealthEvaluationErrorSchema.safeParse({ error: "Unavailable", admission: "not_admitted" }).success).toBe(false);
  });
});
