import { createHmac } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { MobileAuthLedger } from "@/lib/auth/mobile-types";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-mobile-auth-"));
  process.env.OMNIAGENT_AUTH_ENABLED = "true";
  delete process.env.DATABASE_URL;
  delete process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
  delete process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
  // Every private account is admitted by the server-owned allowlist, one
  // account per tenant (ae543b61).
  process.env.OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON = JSON.stringify([
    { email: "mobile@example.com", tenantId: "mobile-tenant", tenantName: "Mobile Tenant", tenantMode: "new", label: "Mobile", role: "operator" },
    { email: "membership-change@example.com", tenantId: "membership-change-tenant", tenantName: "Membership Change Tenant", tenantMode: "new", label: "Membership change", role: "operator" },
    { email: "retry-membership@example.com", tenantId: "retry-membership-tenant", tenantName: "Retry Membership Tenant", tenantMode: "new", label: "Retry membership", role: "operator" },
  ]);
});

describe("native mobile authentication", () => {
  it("locks only the authoritative session row during Postgres refresh", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src/lib/auth/mobile.ts"),
      "utf8",
    );
    const refreshSource = source.slice(
      source.indexOf("export async function rotateMobileRefreshToken"),
      source.indexOf("export async function recordMobileSessionSeen"),
    );
    expect(refreshSource).toContain("LIMIT 1\n          FOR UPDATE OF session");
    expect(refreshSource).not.toMatch(/FOR UPDATE(?! OF session)/);
  });

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
    const next = await mobile.rotateMobileRefreshToken(rotated.tokens.refreshToken, "ios-device-0001");
    // Two rotations ago, so it is not a retry.
    await expect(mobile.rotateMobileRefreshToken(signedIn!.tokens.refreshToken, "ios-device-0001"))
      .rejects.toMatchObject({ code: "refresh_token_reuse" });
    await expect(mobile.rotateMobileRefreshToken(next.tokens.refreshToken, "ios-device-0001"))
      .rejects.toMatchObject({ code: "invalid_refresh_token" });
  });

  it("revokes an access token and never falls back from an invalid bearer to browser/default auth", async () => {
    const auth = await import("@/lib/auth/store");
    const mobile = await import("@/lib/auth/mobile");
    const security = await import("@/lib/security/context");
    const { AUTH_SESSION_COOKIE } = await import("@/lib/auth/session");
    const browserSession = await auth.authenticatePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
    });
    expect(browserSession).not.toBeNull();
    const cookie = `${AUTH_SESSION_COOKIE}=${browserSession!.token}`;
    const browserRequest = new Request("https://example.test/api/projects", { headers: { cookie } });
    await expect(security.resolveSecurityContext(browserRequest)).resolves.toMatchObject({
      tenantId: "mobile-tenant",
      source: "session",
    });
    const signedIn = await mobile.authenticateMobilePassword({
      email: "mobile@example.com",
      password: "a secure mobile password",
      device: { id: "android-device-1", name: "Work Pixel", platform: "android" },
    });
    await mobile.revokeMobileSession(signedIn!.identity);
    const revoked = new Request("https://example.test/api/projects", { headers: { authorization: `Bearer ${signedIn!.tokens.accessToken}` } });
    await expect(security.resolveSecurityContext(revoked)).rejects.toMatchObject({ status: 401 });
    const malformed = new Request("https://example.test/api/projects", {
      headers: { authorization: "Bearer malformed", cookie },
    });
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

describe("a refresh token that was just replaced", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gets the pair that replaced it again, with or without the native attestation", async () => {
    const mobile = await import("@/lib/auth/mobile");
    const signedIn = await signInDevice("retry-same-pair");
    const rotated = await mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, "retry-same-pair");

    await expect(mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, "retry-same-pair"))
      .resolves.toMatchObject({ tokens: rotated.tokens });
    await expect(mobile.rotateMobileRefreshToken(
      signedIn.tokens.refreshToken,
      "retry-same-pair",
      iosClient,
    )).resolves.toMatchObject({ tokens: rotated.tokens });
    await expect(mobile.getMobileIdentityFromRequest(bearer(rotated.tokens.accessToken)))
      .resolves.toMatchObject({ session: { id: signedIn.identity.session.id } });

    // Once the next rotation replaces that pair, only its own predecessor is a retry.
    const next = await mobile.rotateMobileRefreshToken(rotated.tokens.refreshToken, "retry-same-pair");
    expect(next.tokens.accessToken).not.toBe(rotated.tokens.accessToken);
    expect(next.tokens.refreshToken).not.toBe(rotated.tokens.refreshToken);
    await expect(mobile.rotateMobileRefreshToken(rotated.tokens.refreshToken, "retry-same-pair"))
      .resolves.toMatchObject({ tokens: next.tokens });
    await expect(mobile.getMobileIdentityFromRequest(bearer(rotated.tokens.accessToken)))
      .resolves.toBeNull();
    await expect(mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, "retry-same-pair"))
      .rejects.toMatchObject({ code: "refresh_token_reuse" });
    await expect(mobile.rotateMobileRefreshToken(next.tokens.refreshToken, "retry-same-pair"))
      .rejects.toMatchObject({ code: "invalid_refresh_token" });
  });

  it("derives the pair from itself and a key the ledger keeps, so the ledger holds neither token", async () => {
    const mobile = await import("@/lib/auth/mobile");
    const signedIn = await signInDevice("retry-derivation");
    const rotated = await mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, "retry-derivation");
    const persisted = await readFile(mobileLedgerFile(), "utf8");
    const session = (JSON.parse(persisted) as MobileAuthLedger).sessions
      .find((item) => item.id === signedIn.identity.session.id);
    const key = session?.refreshRotation?.key ?? "";
    const derive = (purpose: string) =>
      createHmac("sha256", Buffer.from(key, "base64url"))
        .update(`asael-mobile-rotation:v1:${purpose}:${signedIn.tokens.refreshToken}`)
        .digest("base64url");

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated.tokens).toMatchObject({
      accessToken: derive("access"),
      refreshToken: derive("refresh"),
    });
    expect(rotated.tokens.accessToken).not.toBe(rotated.tokens.refreshToken);
    for (const token of [
      signedIn.tokens.refreshToken,
      rotated.tokens.accessToken,
      rotated.tokens.refreshToken,
    ]) {
      expect(persisted).not.toContain(token);
    }
  });

  it("is reuse when it comes back more than 60 seconds from its rotation", async () => {
    const mobile = await import("@/lib/auth/mobile");
    for (const [deviceId, offsetMs] of [
      ["retry-late", 61_000],
      // A clock that moved back is outside the window too.
      ["retry-clock-back", -61_000],
    ] as const) {
      const signedIn = await signInDevice(deviceId);
      vi.useFakeTimers({ toFake: ["Date"] });
      const rotatedAt = Date.now();
      const rotated = await mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, deviceId);
      for (const withinMs of [59_000, 60_000]) {
        vi.setSystemTime(rotatedAt + Math.sign(offsetMs) * withinMs);
        await expect(mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, deviceId))
          .resolves.toMatchObject({ tokens: rotated.tokens });
      }

      vi.setSystemTime(rotatedAt + offsetMs);
      await expect(mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, deviceId))
        .rejects.toMatchObject({ code: "refresh_token_reuse" });
      vi.useRealTimers();
      await expect(mobile.rotateMobileRefreshToken(rotated.tokens.refreshToken, deviceId))
        .rejects.toMatchObject({ code: "invalid_refresh_token" });
      await expect(deviceState(signedIn)).resolves.toMatchObject({
        state: "revoked",
        revocationReason: "refresh_reuse",
      });
    }
  });

  it("is reuse from another device or another platform", async () => {
    const mobile = await import("@/lib/auth/mobile");
    for (const [deviceId, retryDeviceId, retryClient] of [
      ["retry-other-device", "retry-someone-else", undefined],
      ["retry-other-platform", "retry-other-platform", { ...iosClient, platform: "android" }],
    ] as const) {
      const signedIn = await signInDevice(deviceId);
      const rotated = await mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, deviceId);

      await expect(mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, retryDeviceId, retryClient))
        .rejects.toMatchObject({ code: "refresh_token_reuse" });
      await expect(mobile.rotateMobileRefreshToken(rotated.tokens.refreshToken, deviceId))
        .rejects.toMatchObject({ code: "invalid_refresh_token" });
      await expect(deviceState(signedIn)).resolves.toMatchObject({
        revocationReason: "refresh_reuse",
      });
    }
  });

  it("is reuse once the pair is not the one derived from it", async () => {
    const mobile = await import("@/lib/auth/mobile");
    // A release without the rotation key replaces both hashes; each one alone
    // is enough to refuse the retry.
    for (const [deviceId, field] of [
      ["retry-replaced-access", "accessTokenHash"],
      ["retry-replaced-refresh", "refreshTokenHash"],
    ] as const) {
      const signedIn = await signInDevice(deviceId);
      await mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, deviceId);
      const ledger = JSON.parse(await readFile(mobileLedgerFile(), "utf8")) as MobileAuthLedger;
      await writeFile(mobileLedgerFile(), JSON.stringify({
        ...ledger,
        sessions: ledger.sessions.map((item) => item.id === signedIn.identity.session.id
          ? { ...item, [field]: "0".repeat(64) }
          : item),
      }), "utf8");

      await expect(mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, deviceId))
        .rejects.toMatchObject({ code: "refresh_token_reuse" });
    }
  });

  it("is refused without reissuing the pair after logout or a membership change", async () => {
    const auth = await import("@/lib/auth/store");
    const mobile = await import("@/lib/auth/mobile");
    const signedIn = await signInDevice("retry-after-logout");
    await mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, "retry-after-logout");
    await mobile.revokeMobileSession(signedIn.identity);

    await expect(mobile.rotateMobileRefreshToken(signedIn.tokens.refreshToken, "retry-after-logout"))
      .rejects.toMatchObject({ code: "invalid_refresh_token" });
    await expect(deviceState(signedIn)).resolves.toMatchObject({
      state: "revoked",
      revocationReason: "logout",
    });

    await auth.createUserWithMembership({
      email: "retry-membership@example.com",
      password: "a secure retry membership password",
      role: "operator",
      tenantId: "retry-membership-tenant",
      tenantName: "Retry Membership Tenant",
    });
    const member = await signInDevice(
      "retry-membership-device",
      "retry-membership@example.com",
      "a secure retry membership password",
    );
    await mobile.rotateMobileRefreshToken(member.tokens.refreshToken, "retry-membership-device");
    const authFile = path.join(process.env.OMNIAGENT_DATA_DIR!, "auth.json");
    const authLedger = JSON.parse(await readFile(authFile, "utf8")) as {
      memberships: Array<{ userId: string; tenantId: string; status: string }>;
    };
    authLedger.memberships = authLedger.memberships.map((membership) =>
      membership.userId === member.identity.user.id
        ? { ...membership, status: "disabled" }
        : membership);
    await writeFile(authFile, `${JSON.stringify(authLedger, null, 2)}\n`, "utf8");

    await expect(mobile.rotateMobileRefreshToken(member.tokens.refreshToken, "retry-membership-device"))
      .rejects.toMatchObject({ code: "invalid_refresh_token" });
    await expect(deviceState(member)).resolves.toMatchObject({
      state: "revoked",
      revocationReason: "membership_changed",
    });
  });
});

const iosClient = {
  platform: "ios",
  appVersion: "1.0.0",
  buildNumber: 1,
  clientContractVersion: 1,
} as const;

function bearer(accessToken: string) {
  return new Request("https://example.test/api/projects", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function mobileLedgerFile() {
  return path.join(process.env.OMNIAGENT_DATA_DIR!, "mobile-auth.json");
}

async function signInDevice(
  deviceId: string,
  email = "mobile@example.com",
  password = "a secure mobile password",
) {
  const mobile = await import("@/lib/auth/mobile");
  const signedIn = await mobile.authenticateMobilePassword({
    email,
    password,
    device: { id: deviceId, name: "Retry iPhone", platform: "ios" },
  });
  expect(signedIn).not.toBeNull();
  return signedIn!;
}

// Reads the session's state from the stored ledger, which still lists it
// after the session itself can no longer authenticate.
async function deviceState(signedIn: Awaited<ReturnType<typeof signInDevice>>) {
  const ledger = JSON.parse(await readFile(mobileLedgerFile(), "utf8")) as MobileAuthLedger;
  const session = ledger.sessions.find((item) => item.id === signedIn.identity.session.id);
  return {
    state: session?.revokedAt ? "revoked" : "active",
    revocationReason: session?.revocationReason,
  };
}
