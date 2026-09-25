import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOAuthAuthorization,
  exchangeOAuthCode,
  isSalesforceInstanceUrl,
  openOAuthState,
  refreshOAuthAccess,
  revokeOAuthAccess,
} from "@/lib/connectors/oauth-providers";

const previous = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  salesforceId: process.env.SALESFORCE_OAUTH_CLIENT_ID,
  salesforceSecret: process.env.SALESFORCE_OAUTH_CLIENT_SECRET,
  url: process.env.NEXT_PUBLIC_APP_URL,
  owner: process.env.OMNIAGENT_OWNER_EMAIL,
};
afterEach(() => {
  vi.restoreAllMocks();
  if (previous.id) process.env.GOOGLE_OAUTH_CLIENT_ID = previous.id; else delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (previous.secret) process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.secret; else delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (previous.salesforceId) process.env.SALESFORCE_OAUTH_CLIENT_ID = previous.salesforceId; else delete process.env.SALESFORCE_OAUTH_CLIENT_ID;
  if (previous.salesforceSecret) process.env.SALESFORCE_OAUTH_CLIENT_SECRET = previous.salesforceSecret; else delete process.env.SALESFORCE_OAUTH_CLIENT_SECRET;
  if (previous.url) process.env.NEXT_PUBLIC_APP_URL = previous.url; else delete process.env.NEXT_PUBLIC_APP_URL;
  if (previous.owner) process.env.OMNIAGENT_OWNER_EMAIL = previous.owner; else delete process.env.OMNIAGENT_OWNER_EMAIL;
});

describe("OAuth provider authorization", () => {
  it("creates an owner-bound PKCE authorization without forced consent", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.OMNIAGENT_OWNER_EMAIL = "owner@example.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://omni.example";
    const url = new URL(createOAuthAuthorization("google", { tenantId: "tenant-a", actorId: "user-a" }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("scope")).toContain("email");
    expect(url.searchParams.get("scope")).toContain("gmail.modify");
    expect(url.searchParams.get("scope")).toContain("calendar.calendarlist.readonly");
    expect(url.searchParams.get("scope")).toContain("/auth/drive");
    // A normal connect asks Google for account selection, never forced consent.
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("login_hint")).toBe("owner@example.com");
    const state = openOAuthState("google", url.searchParams.get("state") || "");
    expect(state).toMatchObject({
      tenantId: "tenant-a",
      actorId: "user-a",
      provider: "google",
      googleConnectionPurpose: "personal",
      googleAccountEmail: "owner@example.com",
    });
  });

  it("rejects tampered state", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.OMNIAGENT_OWNER_EMAIL = "owner@example.com";
    const url = new URL(createOAuthAuthorization("google", { tenantId: "tenant-a", actorId: "user-a" }));
    const state = url.searchParams.get("state") || "";
    expect(() => openOAuthState("google", `${state.slice(0, -2)}aa`)).toThrow();
  });

  it("forces consent only for an explicit authorization repair", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.OMNIAGENT_OWNER_EMAIL = "owner@example.com";
    const url = new URL(createOAuthAuthorization("google", {
      tenantId: "tenant-a",
      actorId: "user-a",
      authorizationIntent: "repair",
    }));
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("creates a read-only Salesforce authorization bound to Account 360", () => {
    process.env.SALESFORCE_OAUTH_CLIENT_ID = "salesforce-client";
    process.env.SALESFORCE_OAUTH_CLIENT_SECRET = "salesforce-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://omni.example";

    const url = new URL(createOAuthAuthorization("salesforce", {
      tenantId: "tenant-a",
      actorId: "user-a",
      returnTo: "/app/accounts",
    }));

    expect(url.origin).toBe("https://login.salesforce.com");
    expect(url.searchParams.get("scope")).toBe("api refresh_token");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("access_type")).toBe(false);
    expect(openOAuthState("salesforce", url.searchParams.get("state") || ""))
      .toMatchObject({
        tenantId: "tenant-a",
        actorId: "user-a",
        provider: "salesforce",
        returnTo: "/app/accounts",
      });
  });

  it("accepts only Salesforce-owned HTTPS instance authorities", async () => {
    process.env.SALESFORCE_OAUTH_CLIENT_ID = "salesforce-client";
    process.env.SALESFORCE_OAUTH_CLIENT_SECRET = "salesforce-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://omni.example";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "token",
        instance_url: "https://tenant.my.salesforce.com",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "token",
        instance_url: "https://attacker.example",
      }), { status: 200 }));

    await expect(exchangeOAuthCode("salesforce", "code", "verifier"))
      .resolves.toMatchObject({ instance_url: "https://tenant.my.salesforce.com" });
    await expect(exchangeOAuthCode("salesforce", "code", "verifier"))
      .rejects.toThrow("invalid instance authority");
    expect(isSalesforceInstanceUrl("https://tenant.my.salesforce.com")).toBe(true);
    expect(isSalesforceInstanceUrl("https://tenant.my.salesforce.com/path")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("validates the Google token account before returning storable tokens", async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.OMNIAGENT_OWNER_EMAIL = "owner@example.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://omni.example";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "identity-token",
        expires_in: 3_600,
      }))
      .mockResolvedValueOnce(json({
        aud: "client-id",
        iss: "https://accounts.google.com",
        email: "OWNER@example.com",
        email_verified: "true",
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        sub: "google-owner-subject",
      }));

    const tokens = await exchangeOAuthCode("google", "code", "verifier");
    expect(tokens).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
      google_account_sub: "google-owner-subject",
    });
    expect(tokens).not.toHaveProperty("id_token");
  });

  it("rejects and revokes a mismatched Google account", async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.OMNIAGENT_OWNER_EMAIL = "owner@example.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://omni.example";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "identity-token",
      }))
      .mockResolvedValueOnce(json({
        aud: "client-id",
        iss: "https://accounts.google.com",
        email: "sibling@example.com",
        email_verified: "true",
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        sub: "sibling-google-subject",
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(exchangeOAuthCode("google", "code", "verifier"))
      .rejects.toMatchObject({ code: "owner_verification_failed" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("distinguishes temporary refresh failure from rejected authorization", async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));

    await expect(refreshOAuthAccess("google", "refresh-token"))
      .rejects.toMatchObject({
        code: "provider_unavailable",
        reconnectRequired: false,
      });
    await expect(refreshOAuthAccess("google", "refresh-token"))
      .rejects.toMatchObject({
        code: "refresh_rejected",
        reconnectRequired: true,
      });
  });

  it("revokes Google access at the provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    await expect(revokeOAuthAccess("google", "refresh-token")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("revokes Salesforce access through the fixed login authority", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    await expect(revokeOAuthAccess("salesforce", "refresh-token"))
      .resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://login.salesforce.com/services/oauth2/revoke",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
