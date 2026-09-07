import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  listReviews: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <T>(handler: T) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/payments/ap2-store", () => ({
  listAp2HumanPresentReviews: mocks.listReviews,
}));
vi.mock("@/lib/payments/ap2-webauthn", () => ({
  loadAp2WebAuthnTrustPolicy: () => undefined,
  publicTrustPolicy: vi.fn(),
}));

import { GET } from "@/app/api/payments/ap2/reviews/route";

describe("AP2 Trusted Surface reviews route", () => {
  beforeEach(() => {
    mocks.authorizeRequest.mockReset().mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      role: "operator",
      source: "service",
    });
    mocks.listReviews.mockReset().mockResolvedValue([]);
  });

  it("uses the exact authenticated owner scope and reports payment disabled", async () => {
    const response = await GET(new Request("https://asael.example/api/payments/ap2/reviews"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.listReviews).toHaveBeenCalledWith({
      tenantId: "tenant-one",
      actorId: "actor-one",
    });
    expect(body).toEqual({
      trustedSurface: "deterministic_non_agentic",
      trustPolicy: null,
      reviews: [],
      transactionsPermitted: false,
    });
  });

  it("does not read another actor's reviews for an unauthorized caller", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("denied"));
    const response = await GET(new Request("https://asael.example/api/payments/ap2/reviews"));
    expect(response.status).toBe(403);
    expect(mocks.listReviews).not.toHaveBeenCalled();
  });
});
