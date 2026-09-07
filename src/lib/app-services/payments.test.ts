import { beforeEach, describe, expect, it, vi } from "vitest";

const paymentStoreMocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/lib/payments/ap2-payment-store", () => ({
  listAp2PaymentTransactions: paymentStoreMocks.list,
  getAp2PaymentTransaction: paymentStoreMocks.get,
}));

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  listAp2PaymentTransactionsService,
  showAp2PaymentTransactionService,
  showAp2ReadinessService,
} from "@/lib/app-services/payments";
import { FIRST_PARTY_APP_TOOLS } from "@/lib/tools/app-registry";

describe("AP2 readiness application service", () => {
  beforeEach(() => {
    paymentStoreMocks.list.mockReset();
    paymentStoreMocks.get.mockReset();
  });

  it("binds the read to the authenticated caller without enabling payment effects", async () => {
    const result = await showAp2ReadinessService(createAppServiceCaller({
      context: {
        tenantId: "tenant-a",
        actorId: "actor-a",
        role: "operator",
        source: "service",
      },
    }), {});

    expect(result.data.readiness.capability.transactionsPermitted).toBe(false);
    expect(result.receipt).toMatchObject({
      operation: "app.payments.ap2.readiness",
      resourceType: "ap2_readiness",
      eventContract: "read_only:no_domain_mutation",
      resourceCount: 1,
    });
  });

  it("exposes preparation and inspection to the agent but keeps signing user-only", () => {
    const paymentTools = FIRST_PARTY_APP_TOOLS
      .filter((tool) => tool.id.startsWith("app.payments."))
      .map((tool) => tool.id);

    expect(paymentTools).toEqual([
      "app.payments.ap2.readiness",
      "app.payments.ap2.transactions.list",
      "app.payments.ap2.transactions.show",
      "app.payments.ap2.mandates.list",
      "app.payments.ap2.mandates.prepare",
    ]);
    expect(paymentTools.some((toolId) => /authoriz|sign|execute|pay$/.test(toolId))).toBe(false);
  });

  it("exposes only actor-scoped evidence projections through read services", async () => {
    const projection = {
      transactionId: "ap2_payment:11111111-1111-4111-8111-111111111111",
      canonicalStatus: "discrepancy",
      paid: false,
      discrepancyCodes: ["capture_total_not_exact"],
    };
    paymentStoreMocks.list.mockResolvedValue([projection]);
    paymentStoreMocks.get.mockResolvedValue(projection);
    const caller = createAppServiceCaller({
      context: {
        tenantId: "tenant-a",
        actorId: "actor-a",
        role: "operator",
        source: "service",
      },
    });

    const listed = await listAp2PaymentTransactionsService(caller, {});
    const shown = await showAp2PaymentTransactionService(caller, {
      transactionId: projection.transactionId,
    });

    expect(paymentStoreMocks.list).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "actor-a",
    });
    expect(paymentStoreMocks.get).toHaveBeenCalledWith(projection.transactionId, {
      tenantId: "tenant-a",
      actorId: "actor-a",
    });
    expect(listed.data.transactions).toEqual([projection]);
    expect(shown.data.transaction).toEqual(projection);
    expect(listed.receipt.eventContract).toBe("read_only:no_domain_mutation");
    expect(shown.receipt.eventContract).toBe("read_only:no_domain_mutation");
  });
});
