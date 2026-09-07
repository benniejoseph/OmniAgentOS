import { describe, expect, it } from "vitest";

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showAp2ReadinessService } from "@/lib/app-services/payments";
import { FIRST_PARTY_APP_TOOLS } from "@/lib/tools/app-registry";

describe("AP2 readiness application service", () => {
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
      "app.payments.ap2.mandates.list",
      "app.payments.ap2.mandates.prepare",
    ]);
    expect(paymentTools.some((toolId) => /authoriz|sign|execute|pay$/.test(toolId))).toBe(false);
  });
});
