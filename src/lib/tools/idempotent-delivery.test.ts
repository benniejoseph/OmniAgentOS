import { describe, expect, it } from "vitest";
import { evaluateLostAcknowledgementRecovery } from "@/lib/tools/idempotent-delivery";

const BINDING = "1".repeat(64);

describe("idempotent mutation delivery", () => {
  it("reconciles a lost acknowledgement before retrying the provider effect", () => {
    expect(evaluateLostAcknowledgementRecovery({
      bindingSha256: BINDING,
      deliveryAttempts: 2,
    })).toEqual({
      attemptCount: 2,
      providerEffectCount: 1,
      receiptCount: 1,
      receipt: {
        bindingSha256: BINDING,
        verification: "read_after_write",
      },
    });
  });

  it("cannot verify before reconciliation or against a different binding", () => {
    expect(evaluateLostAcknowledgementRecovery({
      bindingSha256: BINDING,
      deliveryAttempts: 1,
    })).toMatchObject({ providerEffectCount: 1, receiptCount: 0, receipt: null });
    expect(evaluateLostAcknowledgementRecovery({
      bindingSha256: BINDING,
      observedBindingSha256: "2".repeat(64),
      deliveryAttempts: 2,
    })).toMatchObject({ providerEffectCount: 1, receiptCount: 0, receipt: null });
  });

  it("rejects malformed bindings and unbounded retry budgets", () => {
    expect(() => evaluateLostAcknowledgementRecovery({
      bindingSha256: "not-a-digest",
      deliveryAttempts: 2,
    })).toThrow(/canonical lowercase SHA-256/);
    expect(() => evaluateLostAcknowledgementRecovery({
      bindingSha256: BINDING,
      deliveryAttempts: 9,
    })).toThrow(/1 to 8/);
  });
});
