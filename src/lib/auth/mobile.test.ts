import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
      device: {
        id: "ios-device-0001",
        name: "Work iPhone",
        platform: "ios",
        appVersion: "1.0.0",
        buildNumber: 1,
        clientContractVersion: 1,
      },
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
      source: "mobile",
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
    expect(rotated.tokens.refreshToken).not.toBe(signedIn!.tokens.refreshToken);
    await expect(mobile.rotateMobileRefreshToken(signedIn!.tokens.refreshToken, "ios-device-0001"))
      .rejects.toMatchObject({ code: "refresh_token_reuse" });
    await expect(mobile.rotateMobileRefreshToken(rotated.tokens.refreshToken, "ios-device-0001"))
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
    await mobile.revokeMobileSession(signedIn!.identity);
    const revoked = new Request("https://example.test/api/projects", { headers: { authorization: `Bearer ${signedIn!.tokens.accessToken}` } });
    await expect(security.resolveSecurityContext(revoked)).rejects.toMatchObject({ status: 401 });
    const malformed = new Request("https://example.test/api/projects", { headers: { authorization: "Bearer malformed" } });
    await expect(security.resolveSecurityContext(malformed)).rejects.toMatchObject({ status: 401 });
  });

  it("replaces a reinstalled session and completes a truthful remote-wipe handshake", async () => {
    const mobile = await import("@/lib/auth/mobile");
    const first = await mobile.authenticateMobilePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
      device: { id: "ios-reinstall-1", name: "Work iPhone", platform: "ios" },
    });
    const replacement = await mobile.authenticateMobilePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
      device: { id: "ios-reinstall-1", name: "Work iPhone", platform: "ios" },
    });
    expect(first).not.toBeNull();
    expect(replacement).not.toBeNull();
    await expect(mobile.getMobileIdentityFromRequest(new Request("https://example.test", {
      headers: { authorization: `Bearer ${first!.tokens.accessToken}` },
    }))).resolves.toBeNull();

    const beforeWipe = await mobile.listMobileDeviceSessions(replacement!.identity.context);
    expect(beforeWipe.devices.find((item) => item.id === first!.identity.session.id)).toMatchObject({
      state: "revoked",
      revocationReason: "replaced",
    });
    expect(beforeWipe.devices.find((item) => item.id === replacement!.identity.session.id)).toMatchObject({
      current: true,
      state: "active",
    });

    const wiped = await mobile.changeMobileDeviceLifecycle(
      replacement!.identity.context,
      replacement!.identity.session.id,
      "remote_wipe",
    );
    expect(wiped).toMatchObject({
      current: true,
      state: "wipe_pending",
      wipe: { localErasure: "pending_device_acknowledgement" },
    });
    const challenge = await mobile.getMobileWipeChallengeFromRequest(
      new Request("https://example.test/api/mobile/wipe", {
        headers: { authorization: `Bearer ${replacement!.tokens.accessToken}` },
      }),
    );
    expect(challenge).toMatchObject({
      wipeRequired: true,
      deviceId: "ios-reinstall-1",
    });
    await expect(mobile.acknowledgeMobileWipe(
      challenge!.acknowledgementToken,
      challenge!.deviceId,
    )).resolves.toBe(true);
    await expect(mobile.acknowledgeMobileWipe(
      challenge!.acknowledgementToken,
      challenge!.deviceId,
    )).resolves.toBe(false);
  });

  it("never lets another tenant revoke or wipe a device session", async () => {
    const mobile = await import("@/lib/auth/mobile");
    const signedIn = await mobile.authenticateMobilePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
      device: { id: "android-isolation-1", name: "Work Pixel", platform: "android" },
    });
    await expect(mobile.changeMobileDeviceLifecycle({
      ...signedIn!.identity.context,
      tenantId: "different-tenant",
    }, signedIn!.identity.session.id, "remote_wipe")).resolves.toBeUndefined();
  });

  it("invalidates access and refresh credentials when tenant membership changes", async () => {
    const auth = await import("@/lib/auth/store");
    const mobile = await import("@/lib/auth/mobile");
    await auth.createUserWithMembership({
      email: "membership-change@example.com",
      password: "a secure membership password",
      role: "operator",
      tenantId: "membership-change-tenant",
      tenantName: "Membership Change Tenant",
    });
    const signedIn = await mobile.authenticateMobilePassword({
      email: "membership-change@example.com",
      password: "a secure membership password",
      device: {
        id: "membership-device-1",
        name: "Membership phone",
        platform: "android",
      },
    });
    expect(signedIn).not.toBeNull();

    const authFile = path.join(process.env.OMNIAGENT_DATA_DIR!, "auth.json");
    const ledger = JSON.parse(await readFile(authFile, "utf8")) as {
      memberships: Array<{
        userId: string;
        tenantId: string;
        status: "active" | "disabled";
        updatedAt: string;
      }>;
    };
    ledger.memberships = ledger.memberships.map((membership) =>
      membership.userId === signedIn!.identity.user.id &&
      membership.tenantId === signedIn!.identity.tenant.id
        ? {
            ...membership,
            status: "disabled" as const,
            updatedAt: new Date().toISOString(),
          }
        : membership);
    await writeFile(authFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

    await expect(mobile.getMobileIdentityFromRequest(new Request("https://example.test", {
      headers: { authorization: `Bearer ${signedIn!.tokens.accessToken}` },
    }))).resolves.toBeNull();
    await expect(mobile.rotateMobileRefreshToken(
      signedIn!.tokens.refreshToken,
      "membership-device-1",
    )).rejects.toMatchObject({ code: "invalid_refresh_token" });
    const devices = await mobile.listMobileDeviceSessions(
      signedIn!.identity.context,
    );
    expect(devices.devices.find((device) =>
      device.id === signedIn!.identity.session.id)).toMatchObject({
      state: "revoked",
      revocationReason: "membership_changed",
    });
  });

  it("serves bearer-only device inventory and lifecycle routes end to end", async () => {
    const mobile = await import("@/lib/auth/mobile");
    const [{ GET: listDevices }, { POST: changeDevice }] = await Promise.all([
      import("@/app/api/mobile/devices/route"),
      import("@/app/api/mobile/devices/[id]/route"),
    ]);
    const manager = await mobile.authenticateMobilePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
      device: {
        id: "route-manager-device",
        name: "Manager phone",
        platform: "ios",
      },
    });
    const target = await mobile.authenticateMobilePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
      device: {
        id: "route-target-device",
        name: "Lost phone",
        platform: "android",
      },
    });
    expect(manager).not.toBeNull();
    expect(target).not.toBeNull();

    const listResponse = await listDevices(new Request(
      "https://example.test/api/mobile/devices",
      { headers: { authorization: `Bearer ${manager!.tokens.accessToken}` } },
    ));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      schemaVersion: 1,
      devices: expect.arrayContaining([
        expect.objectContaining({
          id: target!.identity.session.id,
          state: "active",
        }),
      ]),
    });

    const changeResponse = await changeDevice(
      new Request(
        `https://example.test/api/mobile/devices/${target!.identity.session.id}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${manager!.tokens.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "remote_wipe" }),
        },
      ),
      { params: Promise.resolve({ id: target!.identity.session.id }) },
    );
    expect(changeResponse.status).toBe(200);
    await expect(changeResponse.json()).resolves.toMatchObject({
      id: target!.identity.session.id,
      state: "wipe_pending",
      revocationReason: "remote_wipe",
    });
  });
});
