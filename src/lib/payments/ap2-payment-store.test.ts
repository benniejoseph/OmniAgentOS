import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ap2ReconciliationJobSchema,
  buildAp2ReconciliationJob,
} from "@/lib/payments/ap2-payment-store";
import { ap2PaymentProjectionSchema } from "@/lib/payments/ap2-receipts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("P9.18 AP2 reconciliation jobs", () => {
  it("binds one deterministic job to actor, transaction, projection, and idempotency", () => {
    const projection = paymentProjection();
    const input = {
      projection,
      reason: "scheduled" as const,
      idempotencyKey: "provider-sync-1",
      now: new Date("2026-09-07T10:20:00.000Z"),
    };
    const first = buildAp2ReconciliationJob(input, {
      tenantId: "tenant_1",
      actorId: "actor_1",
    });
    const second = buildAp2ReconciliationJob(input, {
      tenantId: "tenant_1",
      actorId: "actor_1",
    });

    expect(first).toEqual(second);
    expect(first.request.requestedProjectionSha256).toBe(projection.projectionSha256);
    expect(first.request.idempotencyKeySha256).toBe(sha256("provider-sync-1"));
    expect(first.state).toBe("queued");
    expect(first.leaseTokenSha256).toBeNull();
  });

  it("rejects actor drift and inconsistent lease state", () => {
    const projection = paymentProjection();
    expect(() => buildAp2ReconciliationJob({
      projection,
      reason: "operator_requested",
      idempotencyKey: "operator-1",
    }, { tenantId: "tenant_1", actorId: "other_actor" })).toThrow(/different actor/i);

    const job = buildAp2ReconciliationJob({
      projection,
      reason: "operator_requested",
      idempotencyKey: "operator-1",
    }, { tenantId: "tenant_1", actorId: "actor_1" });
    expect(() => ap2ReconciliationJobSchema.parse({
      ...job,
      state: "running",
    })).toThrow(/lease state/i);
  });
});

function paymentProjection() {
  const body = {
    version: "p9.18-ap2-receipt-ledger:1" as const,
    transactionId: "ap2_payment:11111111-1111-4111-8111-111111111111",
    tenantId: "tenant_1",
    ownerActorId: "actor_1",
    reviewId: "ap2_review:22222222-2222-4222-8222-222222222222",
    grantId: "ap2_credential_grant:33333333-3333-4333-8333-333333333333",
    merchantSha256: sha256("merchant"),
    amountMinor: 1250,
    currency: "USD",
    checkoutReference: "Y2hlY2tvdXQ",
    paymentReference: "cGF5bWVudA",
    checkoutReceiptSha256: null,
    paymentReceiptSha256: null,
    latestMerchantObservationSha256: null,
    latestProcessorObservationSha256: null,
    checkoutState: "awaiting_receipt" as const,
    paymentState: "awaiting_receipt" as const,
    authorizationState: "unknown" as const,
    captureState: "unknown" as const,
    settlementState: "unknown" as const,
    cancellationState: "unknown" as const,
    refundState: "unknown" as const,
    disputeState: "unknown" as const,
    fulfillmentState: "unknown" as const,
    canonicalStatus: "pending" as const,
    paid: false,
    discrepancyCodes: [],
    lifecycleRevision: 1,
    createdAt: "2026-09-07T10:10:00.000Z",
    updatedAt: "2026-09-07T10:10:00.000Z",
  };
  return ap2PaymentProjectionSchema.parse({
    ...body,
    projectionSha256: canonicalJsonSha256(body),
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
