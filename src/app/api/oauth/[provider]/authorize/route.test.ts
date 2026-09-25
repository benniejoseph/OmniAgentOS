import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  createOAuthAuthorization: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));
vi.mock("@/lib/connectors/oauth-providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/connectors/oauth-providers")>(),
  createOAuthAuthorization: mocks.createOAuthAuthorization,
}));

import { GET } from "@/app/api/oauth/[provider]/authorize/route";

const sessionContext = {
  tenantId: "tenant-a",
  actorId: "owner@example.com",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "22222222-2222-4222-8222-222222222222",
    email: "owner@example.com",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON", JSON.stringify([{
    email: sessionContext.auth.email,
    tenantId: sessionContext.tenantId,
    tenantName: sessionContext.auth.tenantName,
    tenantMode: "existing",
    label: "Personal",
  }]));
  mocks.authorizeRequest.mockResolvedValue(sessionContext);
  mocks.createOAuthAuthorization.mockReturnValue(
    "https://accounts.google.com/o/oauth2/v2/auth?state=test",
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Google OAuth authorization route", () => {
  it("passes repair intent only for an explicit reconnect", async () => {
    const repair = await GET(
      new Request("https://asael.example/api/oauth/google/authorize?intent=repair"),
      { params: Promise.resolve({ provider: "google" }) },
    );
    expect(repair.status).toBe(302);
    expect(mocks.createOAuthAuthorization).toHaveBeenLastCalledWith(
      "google",
      expect.objectContaining({
        tenantId: sessionContext.tenantId,
        actorId: sessionContext.actorId,
        googleConnectionPurpose: "personal",
        googleConnectorAccount: {
          purpose: "personal",
          email: sessionContext.auth.email,
          label: "Personal",
        },
        authorizationIntent: "repair",
      }),
    );

    const ordinary = await GET(
      new Request("https://asael.example/api/oauth/google/authorize"),
      { params: Promise.resolve({ provider: "google" }) },
    );
    expect(ordinary.status).toBe(302);
    const ordinaryIdentity = mocks.createOAuthAuthorization.mock.calls.at(-1)?.[1];
    expect(ordinaryIdentity).not.toHaveProperty("authorizationIntent");
  });

  it("refuses Google authorization without a signed-in private account", async () => {
    mocks.authorizeRequest.mockResolvedValue({
      ...sessionContext,
      source: "default",
      auth: undefined,
    });

    const response = await GET(
      new Request("https://asael.example/api/oauth/google/authorize?intent=repair"),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.createOAuthAuthorization).not.toHaveBeenCalled();
  });

  it("refuses a signed-in account that is outside the private account policy", async () => {
    mocks.authorizeRequest.mockResolvedValue({
      ...sessionContext,
      tenantId: "tenant-b",
    });

    const response = await GET(
      new Request("https://asael.example/api/oauth/google/authorize"),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.createOAuthAuthorization).not.toHaveBeenCalled();
  });

  it("reports missing OAuth configuration before starting authorization", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");

    const response = await GET(
      new Request("https://asael.example/api/oauth/google/authorize"),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Google OAuth is not configured.",
    });
    expect(mocks.createOAuthAuthorization).not.toHaveBeenCalled();
  });

  it("never echoes an internal failure into the browser", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createOAuthAuthorization.mockImplementation(() => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 (asael_owner)");
    });

    const response = await GET(
      new Request("https://asael.example/api/oauth/google/authorize"),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).not.toContain("ECONNREFUSED");
    expect(JSON.parse(body)).toEqual({
      error: "OAuth authorization is temporarily unavailable.",
    });
    expect(consoleError).toHaveBeenCalledWith("OAuth authorization failed.", "Error");
    consoleError.mockRestore();
  });
});
