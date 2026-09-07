import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  loadPolicy: vi.fn(),
  listCredentials: vi.fn(),
}));

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
vi.mock("@/lib/payments/ap2-webauthn", () => ({
  loadAp2WebAuthnTrustPolicy: mocks.loadPolicy,
  beginAp2PaymentCredentialRegistration: vi.fn(),
  completeAp2PaymentCredentialRegistration: vi.fn(),
}));
vi.mock("@/lib/payments/ap2-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/ap2-store")>();
  return {
    ...actual,
    listAp2PaymentSigningCredentials: mocks.listCredentials,
    registerAp2PaymentSigningCredential: vi.fn(),
  };
});
vi.mock("@/lib/security/execution-scope", () => ({
  executionScopeFromSecurityContext: vi.fn(),
}));

import { POST } from "@/app/api/payments/ap2/authenticators/registration/route";

describe("AP2 payment signer registration route", () => {
  beforeEach(() => {
    mocks.authorizeRequest.mockReset().mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      role: "operator",
      source: "service",
    });
    mocks.loadPolicy.mockReset().mockReturnValue(undefined);
    mocks.listCredentials.mockReset().mockResolvedValue([]);
  });

  it("fails closed when no reviewed authenticator trust policy is configured", async () => {
    const response = await POST(new Request(
      "https://asael.example/api/payments/ap2/authenticators/registration",
      { method: "POST" },
    ));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({ error: "trust_policy_required" });
    expect(mocks.listCredentials).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated registration attempt before reading policy", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("denied"));
    const response = await POST(new Request(
      "https://asael.example/api/payments/ap2/authenticators/registration",
      { method: "POST" },
    ));

    expect(response.status).toBe(403);
    expect(mocks.loadPolicy).not.toHaveBeenCalled();
  });
});
