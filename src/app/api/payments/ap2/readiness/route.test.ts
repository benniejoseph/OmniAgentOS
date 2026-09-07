import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorizeRequest: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <T>(handler: T) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json(
    { error: "Forbidden" },
    { status: 403, headers: { "cache-control": "private, no-store" } },
  ),
}));

import { GET } from "@/app/api/payments/ap2/readiness/route";

describe("AP2 readiness route", () => {
  beforeEach(() => {
    mocks.authorizeRequest.mockReset().mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      role: "operator",
      source: "service",
    });
  });

  it("returns the authenticated, non-cacheable, disabled AP2 boundary", async () => {
    const response = await GET(new Request(
      "http://localhost/api/payments/ap2/readiness",
    ));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.readiness.capability).toMatchObject({
      state: "disabled_configuration_only",
      transactionsPermitted: false,
      registeredPaymentEffectToolCount: 0,
    });
    expect(body.readiness.roleContracts).toHaveLength(5);
    expect(body.serviceReceipt).toMatchObject({
      operation: "app.payments.ap2.readiness",
      accessMode: "read",
      resourceCount: 1,
    });
    expect(serialized).not.toContain("tenant-one");
    expect(serialized).not.toContain("actor-one");
    expect(serialized).not.toContain("paymentCredential");
    expect(serialized).not.toContain("privateKey");
  });

  it("fails closed for an unauthorized caller", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("denied"));
    const response = await GET(new Request(
      "http://localhost/api/payments/ap2/readiness",
    ));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
