import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleOwnerAuthorization,
  exchangeGoogleOwnerCode,
  googleOwnerLoginConfigured,
} from "@/lib/auth/google";

const previous = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  owner: process.env.OMNIAGENT_OWNER_EMAIL,
  url: process.env.NEXT_PUBLIC_APP_URL,
};

afterEach(() => {
  vi.restoreAllMocks();
  restore("GOOGLE_OAUTH_CLIENT_ID", previous.id);
  restore("GOOGLE_OAUTH_CLIENT_SECRET", previous.secret);
  restore("OMNIAGENT_OWNER_EMAIL", previous.owner);
  restore("NEXT_PUBLIC_APP_URL", previous.url);
});

describe("Google owner login", () => {
  it("creates a short-lived PKCE OpenID request for the private owner", () => {
    configure();
    const url = new URL(createGoogleOwnerAuthorization());
    expect(googleOwnerLoginConfigured()).toBe(true);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://asael.example/api/auth/google/callback",
    );
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBeTruthy();
  });

  it("accepts only the verified configured owner identity", async () => {
    configure();
    const authorization = new URL(createGoogleOwnerAuthorization());
    const nonce = authorization.searchParams.get("nonce");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ id_token: "verified-id-token", access_token: "access" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          aud: "client-id",
          iss: "https://accounts.google.com",
          exp: Math.floor(Date.now() / 1_000) + 300,
          nonce,
          email: "owner@example.com",
          email_verified: "true",
          name: "Owner",
        }),
      );
    await expect(
      exchangeGoogleOwnerCode("authorization-code", authorization.searchParams.get("state") || ""),
    ).resolves.toEqual({ email: "owner@example.com", name: "Owner" });
  });
});

function configure() {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
  process.env.OMNIAGENT_OWNER_EMAIL = "owner@example.com";
  process.env.NEXT_PUBLIC_APP_URL = "https://asael.example";
}

function restore(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
