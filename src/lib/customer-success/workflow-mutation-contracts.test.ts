import { describe, expect, it } from "vitest";
import { CUSTOMER_SUCCESS_WORKFLOW_IDS } from "@/lib/customer-success/workflow-contracts";
import { buildCustomerSuccessWorkflowNativeAcceptance, buildCustomerSuccessWorkflowNativeIntent,
  customerSuccessWorkflowNativeAcceptanceSchema, customerSuccessWorkflowNativeOutcomeRequestSchema,
  customerSuccessWorkflowNativeStartRequestSchema } from "@/lib/customer-success/workflow-mutation-contracts";
import { workflowActorId, workflowFixture } from "@/lib/customer-success/workflow-mutation.test-fixtures";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("native workflow exact intents", () => {
  it.each(CUSTOMER_SUCCESS_WORKFLOW_IDS)("normalizes and seals %s without effect authority", (workflowId) => {
    const fixture = workflowFixture(workflowId);
    expect(fixture.acceptance.operation).toBe("start"); expect(fixture.acceptance.runRevision).toBe(1);
    expect(fixture.acceptance.outcomeStatus).toBe("in_progress"); expect(fixture.acceptance.effectAuthority).toBe("none");
    expect(fixture.intent.request).not.toHaveProperty("contract"); expect(fixture.intent.request).not.toHaveProperty("workspaceId");
    expect(fixture.acceptance.requestSha256).toBe(canonicalJsonSha256(fixture.intent));
  });
  it("keeps outcome review Account separate from the run's original Account", () => {
    const fixture = workflowFixture("risk_escalation", "outcome");
    expect(fixture.acceptance.reviewedAccountRevision).toBe(4); expect(fixture.acceptance.runAccountRevision).toBe(3);
    expect(fixture.acceptance.runRevision).toBe(2); expect(fixture.acceptance.outcomeStatus).toBe("blocked");
    expect(fixture.intent.request).not.toHaveProperty("recordedAt"); expect(fixture.intent.request).not.toHaveProperty("receiptSha256");
    const repeated = buildCustomerSuccessWorkflowNativeIntent({ ...fixture, canonicalActorId: workflowActorId, idempotencyKey: fixture.key });
    expect(canonicalJsonSha256(repeated)).toBe(fixture.acceptance.requestSha256);
    expect(buildCustomerSuccessWorkflowNativeAcceptance(repeated, fixture.run)).toEqual(fixture.acceptance);
  });
  it("refuses overflow, extra identity, unsafe money and omitted outcome evidence", () => {
    const fixture = workflowFixture("renewal_planning");
    expect(customerSuccessWorkflowNativeStartRequestSchema.safeParse({ ...fixture.start, expectedAccountRevision: 2_147_483_648 }).success).toBe(false);
    expect(customerSuccessWorkflowNativeStartRequestSchema.safeParse({ ...fixture.start, accountId: fixture.accountId }).success).toBe(false);
    expect(customerSuccessWorkflowNativeStartRequestSchema.safeParse({ ...fixture.start, input: { ...fixture.start.input, amountMinor: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
    expect(customerSuccessWorkflowNativeOutcomeRequestSchema.safeParse({ ...fixture.outcome, artifactReceipts: undefined }).success).toBe(false);
  });
  it("refuses tampered acceptance even if its outer digest is recomputed", () => {
    const fixture = workflowFixture();
    const { acceptanceSha256: _sha, ...body } = fixture.acceptance; void _sha;
    const changed = { ...body, runRevision: 2, runRevisionId: `${body.runId}:v2` };
    expect(customerSuccessWorkflowNativeAcceptanceSchema.safeParse({ ...changed, acceptanceSha256: canonicalJsonSha256(changed) }).success).toBe(false);
    expect(() => buildCustomerSuccessWorkflowNativeAcceptance(fixture.intent, { ...fixture.run, ownerActorId: "other" })).toThrow();
  });
});
