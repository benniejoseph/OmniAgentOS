import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  createOAuthAuthorization: vi.fn(),
  getOAuthGrantSecrets: vi.fn(),
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
vi.mock("@/lib/connectors/oauth-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/connectors/oauth-store")>(),
  getOAuthGrantSecrets: mocks.getOAuthGrantSecrets,
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
    expect(ordinaryIdentity).not.toHaveProperty("googleWriteAccess");
  });

  it("asks to allow one service's changes only on the owner's existing connection", async () => {
    const connectionId = "33333333-3333-4333-8333-333333333333";
    const url = `https://asael.example/api/oauth/google/authorize?account=personal&connectionId=${connectionId}&access=gmail`;
    mocks.getOAuthGrantSecrets.mockResolvedValue({ grant: { id: connectionId } });

    const allowed = await GET(new Request(url), { params: Promise.resolve({ provider: "google" }) });
    expect(allowed.status).toBe(302);
    expect(mocks.getOAuthGrantSecrets).toHaveBeenCalledWith(
      sessionContext.tenantId,
      sessionContext.actorId,
      "google",
      { connectionId, connectionPurpose: "personal" },
    );
    expect(mocks.createOAuthAuthorization).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ connectionId, googleWriteAccess: "gmail" }),
    );
    expect(mocks.createOAuthAuthorization.mock.calls[0]?.[1]).not.toHaveProperty("authorizationIntent");

    mocks.getOAuthGrantSecrets.mockResolvedValue(undefined);
    const missing = await GET(new Request(url), { params: Promise.resolve({ provider: "google" }) });
    expect(missing.status).toBe(404);
    expect(mocks.createOAuthAuthorization).toHaveBeenCalledOnce();
  });

  it("refuses to ask for changes to an unlisted service or without a connection", async () => {
    const connection = "connectionId=33333333-3333-4333-8333-333333333333";
    for (const query of [
      "access=gmail",
      `access=photos&${connection}`,
      `access=Gmail&${connection}`,
      `access=&${connection}`,
    ]) {
      const response = await GET(
        new Request(`https://asael.example/api/oauth/google/authorize?${query}`),
        { params: Promise.resolve({ provider: "google" }) },
      );
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({
        error: "Changes can be allowed only for a listed Google service on an existing connection.",
      });
    }
    expect(mocks.getOAuthGrantSecrets).not.toHaveBeenCalled();
    expect(mocks.createOAuthAuthorization).not.toHaveBeenCalled();
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
