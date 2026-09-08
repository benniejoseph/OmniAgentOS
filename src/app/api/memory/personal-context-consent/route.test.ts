import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getStatus: vi.fn(),
  activate: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 401 }),
}));
vi.mock("@/lib/memory/personal-context-consent-store", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/lib/memory/personal-context-consent-store")
  >();
  return {
    ...original,
    getPersonalContextConsentStatus: mocks.getStatus,
    activatePersonalContextConsent: mocks.activate,
    revokePersonalContextConsent: mocks.revoke,
  };
});
vi.mock("@/lib/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...original,
    withDatabaseRequestScope: (handler: unknown) => handler,
  };
});

import { PERSONAL_CONTEXT_NOTICE_SHA256 } from "@/lib/memory/personal-context-consent";
import { DELETE, GET, POST } from "@/app/api/memory/personal-context-consent/route";

const securityContext = {
  tenantId: "tenant:test",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.test",
    sessionId: "session:test",
    tenantName: "Test",
  },
};
const inactiveStatus = {
  schemaVersion: 1,
  state: "inactive",
  notice: {
    contractId: "notice:personal-context-automatic",
    version: 1,
    text: "notice",
    sha256: PERSONAL_CONTEXT_NOTICE_SHA256,
  },
  authority: null,
};

describe("personal context consent route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue(securityContext);
    mocks.getStatus.mockResolvedValue(inactiveStatus);
    mocks.activate.mockResolvedValue({ ...inactiveStatus, state: "active" });
    mocks.revoke.mockResolvedValue(inactiveStatus);
  });

  it("returns private, authenticated consent status", async () => {
    const response = await GET(new Request(
      "https://app.example.test/api/memory/personal-context-consent",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "personal_context_consent",
    }));
  });

  it("activates only the exact reviewed notice", async () => {
    const response = await POST(new Request(
      "https://app.example.test/api/memory/personal-context-consent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256 }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant:test",
      noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256,
      executionScope: expect.objectContaining({
        initiatingActorId: "actor:11111111-1111-4111-8111-111111111111",
        executingPrincipalType: "user",
      }),
    }));

    const stale = await POST(new Request(
      "https://app.example.test/api/memory/personal-context-consent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noticeSha256: "0".repeat(64) }),
      },
    ));
    expect(stale.status).toBe(409);
  });

  it("revokes through an attributed owner mutation", async () => {
    const response = await DELETE(new Request(
      "https://app.example.test/api/memory/personal-context-consent",
      { method: "DELETE" },
    ));

    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(expect.objectContaining({
      executionScope: expect.objectContaining({
        purpose: "memory.personal_context_consent.manage",
      }),
    }));
  });

  it("does not expose status to an unauthenticated request", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("unauthenticated"));
    const response = await GET(new Request(
      "https://app.example.test/api/memory/personal-context-consent",
    ));
    expect(response.status).toBe(401);
  });
});
