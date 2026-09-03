import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-mobile-auth-"));
  process.env.OMNIAGENT_AUTH_ENABLED = "true";
  delete process.env.DATABASE_URL;
  delete process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
  delete process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
});

describe("native mobile authentication", () => {
  it("binds hashed tokens to the user, tenant, and device and resolves bearer RBAC context", async () => {
    const auth = await import("@/lib/auth/store");
    const mobile = await import("@/lib/auth/mobile");
    const security = await import("@/lib/security/context");
    await auth.createUserWithMembership({
      email: "mobile@example.com",
      password: "a secure mobile password",
      role: "operator",
      tenantId: "mobile-tenant",
      tenantName: "Mobile Tenant",
    });
    const signedIn = await mobile.authenticateMobilePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
      device: { id: "ios-device-0001", name: "Work iPhone", platform: "ios", appVersion: "1.0.0" },
    });
    expect(signedIn).not.toBeNull();
    const accessToken = signedIn!.tokens.accessToken;
    const refreshToken = signedIn!.tokens.refreshToken;
    const persisted = await readFile(path.join(process.env.OMNIAGENT_DATA_DIR!, "mobile-auth.json"), "utf8");
    expect(persisted).not.toContain(accessToken);
    expect(persisted).not.toContain(refreshToken);

    const request = new Request("https://example.test/api/projects", { headers: { authorization: `Bearer ${accessToken}` } });
    await expect(security.resolveSecurityContext(request)).resolves.toMatchObject({
      tenantId: "mobile-tenant",
      role: "operator",
      auth: { userId: signedIn!.identity.user.id, sessionId: signedIn!.identity.session.id },
    });
  });

  it("rotates refresh credentials, rejects a different device, and revokes the family on replay", async () => {
    const mobile = await import("@/lib/auth/mobile");
    const signedIn = await mobile.authenticateMobilePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
      device: { id: "ios-device-0001", name: "Work iPhone", platform: "ios" },
    });
    await expect(mobile.rotateMobileRefreshToken(signedIn!.tokens.refreshToken, "wrong-device-0001"))
      .rejects.toMatchObject({ code: "invalid_refresh_token" });

    const rotated = await mobile.rotateMobileRefreshToken(signedIn!.tokens.refreshToken, "ios-device-0001");
    expect(rotated.refreshToken).not.toBe(signedIn!.tokens.refreshToken);
    await expect(mobile.rotateMobileRefreshToken(signedIn!.tokens.refreshToken, "ios-device-0001"))
      .rejects.toMatchObject({ code: "refresh_token_reuse" });
    await expect(mobile.rotateMobileRefreshToken(rotated.refreshToken, "ios-device-0001"))
      .rejects.toMatchObject({ code: "invalid_refresh_token" });
  });

  it("revokes an access token and never falls back from an invalid bearer to browser/default auth", async () => {
    const mobile = await import("@/lib/auth/mobile");
    const security = await import("@/lib/security/context");
    const signedIn = await mobile.authenticateMobilePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
      device: { id: "android-device-1", name: "Work Pixel", platform: "android" },
    });
    await mobile.revokeMobileSession(signedIn!.tokens.accessToken);
    const revoked = new Request("https://example.test/api/projects", { headers: { authorization: `Bearer ${signedIn!.tokens.accessToken}` } });
    await expect(security.resolveSecurityContext(revoked)).rejects.toMatchObject({ status: 401 });
    const malformed = new Request("https://example.test/api/projects", { headers: { authorization: "Bearer malformed" } });
    await expect(security.resolveSecurityContext(malformed)).rejects.toMatchObject({ status: 401 });
  });
});
