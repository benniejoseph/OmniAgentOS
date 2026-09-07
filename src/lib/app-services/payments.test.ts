import { describe, expect, it } from "vitest";

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showAp2ReadinessService } from "@/lib/app-services/payments";

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
});
