import { describe, expect, it } from "vitest";
import { authorizeAppServiceCall, completeAppServiceCall } from "@/lib/app-services/contracts";
import {
  nativeCustomerWorkflowAcceptanceReadResponseForScopeSchema, nativeCustomerWorkflowMutationResponseForScopeSchema,
  nativeCustomerWorkflowMutationResponseSchema, nativeCustomerWorkflowRunReadResponseForScopeSchema,
} from "@/lib/mobile/customer-workflow-mutation-contracts";
import { workflowAccess, workflowAt, workflowCaller, workflowContext, workflowFixture } from "@/lib/customer-success/workflow-mutation.test-fixtures";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

function wire(operation: "start" | "outcome", replayed = false) {
  const fixture = workflowFixture("risk_escalation", operation), access = workflowAccess(), caller = workflowCaller(operation);
  const data = { contract: "customer-success-workflow-read:1" as const,
    context: { scope: "workspace" as const, workspaceId: fixture.workspaceId, accessLevel: "manager" as const,
      canWrite: true, authoritySha256: access.authority.authoritySha256 },
    currentAccount: fixture.currentAccount, acceptance: fixture.acceptance, replayed };
  const result = completeAppServiceCall(authorizeAppServiceCall(caller, {
    operation: operation === "start" ? "app.customer_accounts.workflows.start" : "app.customer_accounts.workflows.outcome.record",
    action: operation === "start" ? "run.agent" : "manage.workflow", resourceType: operation === "start" ? "customer_success_workflow" : "customer_success_workflow_outcome",
    accessMode: "mutation", eventContract: operation === "start" ? "customer-success-workflow-events.v1+projects.atomic-events.v1" : "customer-success-workflow-events.v1",
  }), data, { resourceCount: 1, occurredAt: workflowAt });
  return { fixture, value: { ...result.data, serviceReceipt: result.receipt }, expected: {
    tenantId: fixture.tenantId, workspaceId: fixture.workspaceId, accountId: fixture.accountId, canonicalActorId: fixture.canonicalActorId,
    requestActorId: workflowContext.actorId, role: workflowContext.role,
    request: fixture.request, idempotencyKey: fixture.key, executionScope: caller.executionScope!,
  } };
}
function resign<T extends { serviceReceipt: ReturnType<typeof wire>["value"]["serviceReceipt"] }>(value: T): T {
  const { serviceReceipt, ...data } = value, { receiptSha256: _hash, ...body } = serviceReceipt; void _hash;
  const receipt = { ...body, outcomeSha256: canonicalJsonSha256(data) };
  return { ...value, serviceReceipt: { ...receipt, receiptSha256: canonicalJsonSha256(receipt) } };
}
describe("native workflow public receipts", () => {
  it.each(["start", "outcome"] as const)("binds the exact compact %s intent and request authority", (operation) => {
    const { fixture, expected, value } = wire(operation);
    expect(nativeCustomerWorkflowMutationResponseForScopeSchema(expected).safeParse(value).success).toBe(true);
    expect(value.acceptance.idempotencyKeySha256).toBe(value.serviceReceipt.idempotencyKeySha256);
    expect(value.acceptance.requestSha256).toBe(canonicalJsonSha256(fixture.intent));
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(700_000);
    expect(value).not.toHaveProperty("run"); expect(value).not.toHaveProperty("project");
    for (const override of [{ requestActorId: "another@example.test" }, { role: "viewer" }, { workspaceId: "workspace:other" },
      { canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" }]) {
      // An inconsistent expected workspace is refused while constructing the
      // frozen intent; other mismatches are refused while parsing the reply.
      expect(() => nativeCustomerWorkflowMutationResponseForScopeSchema({ ...expected, ...override }).parse(value)).toThrow();
    }
  });
  it("permits newer current Account only on replay and rejects equal-hash mismatch or rollback", () => {
    const { value } = wire("outcome", true);
    value.currentAccount = { ...value.currentAccount, revision: 5, revisionId: `${value.currentAccount.accountId}:v5`, accountSha256: "e".repeat(64) };
    expect(nativeCustomerWorkflowMutationResponseSchema.safeParse(resign(value)).success).toBe(true);
    value.replayed = false;
    expect(nativeCustomerWorkflowMutationResponseSchema.safeParse(resign(value)).success).toBe(false);
    value.replayed = true; value.currentAccount.revision = 3; value.currentAccount.revisionId = `${value.currentAccount.accountId}:v3`;
    expect(nativeCustomerWorkflowMutationResponseSchema.safeParse(resign(value)).success).toBe(false);
  });
  it("requires a receipt read to use its exact owner/run/key without write authority", () => {
    const { fixture, value, expected } = wire("start");
    const data = { contract: value.contract, context: { ...value.context, canWrite: false, accessLevel: "reader" as const },
      currentAccount: value.currentAccount, acceptance: value.acceptance };
    const readCaller = workflowCaller();
    const result = completeAppServiceCall(authorizeAppServiceCall(readCaller, { operation: "app.customer_accounts.workflows.mutations.show",
      action: "read", resourceType: "customer_success_workflow", accessMode: "read", eventContract: "read_only:no_domain_mutation" }), data, { resourceCount: 1 });
    const scope = { ...expected, runId: fixture.run.runId, keySha256: fixture.intent.idempotencyKeySha256 };
    expect(nativeCustomerWorkflowAcceptanceReadResponseForScopeSchema(scope).safeParse({ ...data, serviceReceipt: result.receipt }).success).toBe(true);
    expect(nativeCustomerWorkflowAcceptanceReadResponseForScopeSchema({ ...scope, keySha256: "f".repeat(64) }).safeParse({ ...data, serviceReceipt: result.receipt }).success).toBe(false);
  });
  it("can describe an exact current run with definition and project unavailable", () => {
    const { fixture, expected, value } = wire("start");
    const data = { contract: value.contract, context: value.context, currentAccount: value.currentAccount,
      run: fixture.run, definition: null, definitionAvailability: "unavailable" as const, projectProgress: { state: "unavailable" as const } };
    const result = completeAppServiceCall(authorizeAppServiceCall(workflowCaller(), { operation: "app.customer_accounts.workflows.show",
      action: "read", resourceType: "customer_success_workflow", accessMode: "read", eventContract: "read_only:no_domain_mutation" }), data, { resourceCount: 1 });
    expect(nativeCustomerWorkflowRunReadResponseForScopeSchema({ ...expected, runId: fixture.run.runId }).safeParse({ ...data, serviceReceipt: result.receipt }).success).toBe(true);
  });
});
