import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ap2PaymentProjectionSchema } from "@/lib/payments/ap2-receipts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), unsafe: vi.fn(), ensure: vi.fn(), configured: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensure,
  hasDatabaseUrl: mocks.configured,
  getSql: () => Object.assign(mocks.query, { unsafe: mocks.unsafe }),
}));
import { getAp2PaymentTransaction, listAp2PaymentTransactions } from "./ap2-payment-store";

const owner = { tenantId: "tenant_1", actorId: "actor_1" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.configured.mockReturnValue(true);
  mocks.query.mockResolvedValue([]); mocks.unsafe.mockResolvedValue([]);
});

describe("AP2 historical transaction reads", () => {
  it("reads the owner's validated transaction projections with a bounded list", async () => {
    const projection = paymentProjection();
    mocks.query.mockResolvedValue([{ projection }]);
    expect(await listAp2PaymentTransactions(owner)).toEqual([projection]);
    const [sql, ...values] = mocks.query.mock.calls[0];
    expect(sql.join("?")).toContain("WHERE tenant_id = ? AND owner_actor_id = ?");
    expect(sql.join("?")).toContain("LIMIT 100");
    expect(values).toEqual([owner.tenantId, owner.actorId]);
  });

  it("binds an exact read to both tenant and actor and preserves a missing record", async () => {
    const projection = paymentProjection();
    mocks.unsafe.mockResolvedValueOnce([{ projection }]);
    expect(await getAp2PaymentTransaction(projection.transactionId, owner)).toEqual(projection);
    expect(mocks.unsafe).toHaveBeenCalledWith(
      expect.stringContaining("WHERE tenant_id = $1 AND owner_actor_id = $2 AND transaction_id = $3"),
      [owner.tenantId, owner.actorId, projection.transactionId],
    );
    expect(await getAp2PaymentTransaction(projection.transactionId, owner)).toBeUndefined();
  });

  it("refuses malformed retained evidence instead of showing a fabricated payment", async () => {
    mocks.query.mockResolvedValue([{ projection: { ...paymentProjection(), paid: true } }]);
    await expect(listAp2PaymentTransactions(owner)).rejects.toThrow();
  });

  it("requires durable storage and an explicit owner", async () => {
    mocks.configured.mockReturnValue(false);
    await expect(listAp2PaymentTransactions(owner)).rejects.toMatchObject({ code: "database_required" });
    await expect(listAp2PaymentTransactions({ ...owner, actorId: "" })).rejects.toThrow(/actor is invalid/);
    expect(mocks.query).not.toHaveBeenCalled();
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
