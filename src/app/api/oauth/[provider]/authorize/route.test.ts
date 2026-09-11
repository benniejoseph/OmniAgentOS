import { beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "owner@example.com",
  });
  mocks.createOAuthAuthorization.mockReturnValue(
    "https://accounts.google.com/o/oauth2/v2/auth?state=test",
  );
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
      expect.objectContaining({ authorizationIntent: "repair" }),
    );

    await GET(
      new Request("https://asael.example/api/oauth/google/authorize"),
      { params: Promise.resolve({ provider: "google" }) },
    );
    const ordinaryIdentity = mocks.createOAuthAuthorization.mock.calls.at(-1)?.[1];
    expect(ordinaryIdentity).not.toHaveProperty("authorizationIntent");
  });
});
