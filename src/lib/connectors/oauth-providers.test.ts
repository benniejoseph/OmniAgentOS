import { afterEach, describe, expect, it } from "vitest";
import { createOAuthAuthorization, openOAuthState } from "@/lib/connectors/oauth-providers";

const previous = { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, url: process.env.NEXT_PUBLIC_APP_URL };
afterEach(() => {
  if (previous.id) process.env.GOOGLE_OAUTH_CLIENT_ID = previous.id; else delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (previous.secret) process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.secret; else delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (previous.url) process.env.NEXT_PUBLIC_APP_URL = previous.url; else delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("OAuth provider authorization", () => {
  it("creates a read-only PKCE authorization bound to the actor", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://omni.example";
    const url = new URL(createOAuthAuthorization("google", { tenantId: "tenant-a", actorId: "user-a" }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
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
});
