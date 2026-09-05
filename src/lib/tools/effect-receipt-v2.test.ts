import { describe, expect, it } from "vitest";
import {
  buildEffectReceiptV2,
  buildEffectReceiptV2EventPayload,
  parseEffectReceiptV2,
  type BuildEffectReceiptV2Input,
} from "@/lib/tools/effect-receipt-v2";

const sha = (seed: string) => seed.repeat(64).slice(0, 64);

function directReceipt(
  overrides: Partial<BuildEffectReceiptV2Input> = {},
): BuildEffectReceiptV2Input {
  return {
    effectMode: "live",
    reversible: false,
    executionKind: "direct",
    executionId: "execution:calendar-delete",
    tenantId: "tenant:alpha",
    actorId: "actor:owner",
    executingPrincipalType: "user",
    executingPrincipalId: "actor:owner",
    workflowRunId: null,
    planId: null,
    planSha256: null,
    planNodeId: null,
    toolId: "mcp:calendar:events_delete",
    toolContractSha256: sha("a"),
    approvalState: "approved",
    approvalBindingSha256: sha("b"),
    inputSha256: sha("c"),
    idempotencyKeySha256: sha("d"),
    targetType: "calendar_event",
    targetId: "calendar:event-1",
    providerAcknowledgement: "provider_response",
    providerAcknowledgementId: "provider:request-1",
    providerAcknowledgementSha256: sha("e"),
    verificationMethod: "read_after_write",
    verificationState: "verified",
    verificationReasonCode: "state_matched",
    expectedTargetStateSha256: sha("f"),
    observedTargetStateSha256: sha("f"),
    ...overrides,
  };
}

describe("effect receipt v2", () => {
  it("builds deterministic generic provider receipts and compact events", () => {
    const receipt = buildEffectReceiptV2(directReceipt());
    expect(buildEffectReceiptV2(directReceipt())).toEqual(receipt);
    expect(parseEffectReceiptV2(receipt, {
      executionId: receipt.executionId,
      tenantId: receipt.tenantId,
      actorId: receipt.actorId,
      toolId: receipt.toolId,
      approvalBindingSha256: receipt.approvalBindingSha256,
      targetType: receipt.targetType,
      targetId: receipt.targetId,
    })).toEqual(receipt);

    const event = buildEffectReceiptV2EventPayload(receipt);
    expect(event).toMatchObject({
      schemaVersion: 2,
      effectReceiptId: receipt.effectReceiptId,
      effectReceiptSha256: receipt.receiptSha256,
      toolId: "mcp:calendar:events_delete",
      verificationState: "verified",
    });
    expect(event).not.toHaveProperty("providerAcknowledgementId");
  });

  it("binds complete workflow identity and exact approval state", () => {
    expect(() => buildEffectReceiptV2(directReceipt({
      executionKind: "workflow",
      executingPrincipalType: "system",
      executingPrincipalId: "workflow:run-1",
      workflowRunId: "run-1",
      planId: null,
    }))).toThrow(/every workflow plan binding/i);
    expect(() => buildEffectReceiptV2(directReceipt({
      approvalState: "not_required",
    }))).toThrow(/approval state and approval binding/i);
  });

  it("rejects false verification and digest tampering", () => {
    expect(() => buildEffectReceiptV2(directReceipt({
      observedTargetStateSha256: sha("0"),
    }))).toThrow(/exactly match/i);

    const receipt = buildEffectReceiptV2(directReceipt());
    expect(() => parseEffectReceiptV2({
      ...receipt,
      targetId: "calendar:event-2",
    })).toThrow(/digest|ID does not match/i);
    expect(() => parseEffectReceiptV2({
      ...receipt,
      rawProviderOutput: "must never be persisted",
    })).toThrow();
  });
});
