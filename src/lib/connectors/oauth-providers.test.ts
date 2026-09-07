import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOAuthAuthorization,
  exchangeOAuthCode,
  isSalesforceInstanceUrl,
  openOAuthState,
  revokeOAuthAccess,
} from "@/lib/connectors/oauth-providers";

const previous = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  salesforceId: process.env.SALESFORCE_OAUTH_CLIENT_ID,
  salesforceSecret: process.env.SALESFORCE_OAUTH_CLIENT_SECRET,
  url: process.env.NEXT_PUBLIC_APP_URL,
};
afterEach(() => {
  vi.restoreAllMocks();
  if (previous.id) process.env.GOOGLE_OAUTH_CLIENT_ID = previous.id; else delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (previous.secret) process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.secret; else delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (previous.salesforceId) process.env.SALESFORCE_OAUTH_CLIENT_ID = previous.salesforceId; else delete process.env.SALESFORCE_OAUTH_CLIENT_ID;
  if (previous.salesforceSecret) process.env.SALESFORCE_OAUTH_CLIENT_SECRET = previous.salesforceSecret; else delete process.env.SALESFORCE_OAUTH_CLIENT_SECRET;
  if (previous.url) process.env.NEXT_PUBLIC_APP_URL = previous.url; else delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("OAuth provider authorization", () => {
  it("creates a least-privilege PKCE authorization bound to the actor", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://omni.example";
    const url = new URL(createOAuthAuthorization("google", { tenantId: "tenant-a", actorId: "user-a" }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
    expect(url.searchParams.get("scope")).toContain("gmail.send");
    expect(url.searchParams.get("scope")).toContain("drive.readonly");
    expect(url.searchParams.get("scope")).not.toContain("gmail.modify");
    const state = openOAuthState("google", url.searchParams.get("state") || "");
    expect(state).toMatchObject({ tenantId: "tenant-a", actorId: "user-a", provider: "google" });
  });

  it("rejects tampered state", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    const url = new URL(createOAuthAuthorization("google", { tenantId: "tenant-a", actorId: "user-a" }));
    const state = url.searchParams.get("state") || "";
    expect(() => openOAuthState("google", `${state.slice(0, -2)}aa`)).toThrow();
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
