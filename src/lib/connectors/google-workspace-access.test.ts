import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOAuthGrantSecrets: vi.fn(),
  saveOAuthGrant: vi.fn(),
  refreshOAuthAccess: vi.fn(),
}));

vi.mock("@/lib/connectors/oauth-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/connectors/oauth-store")>(),
  getOAuthGrantSecrets: mocks.getOAuthGrantSecrets,
  saveOAuthGrant: mocks.saveOAuthGrant,
}));
vi.mock("@/lib/connectors/oauth-providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/connectors/oauth-providers")>(),
  refreshOAuthAccess: mocks.refreshOAuthAccess,
}));

import { getActiveGoogleWorkspaceAccess } from "@/lib/connectors/google-workspace-access";
import {
  GOOGLE_CALENDAR_EVENTS_READ_SCOPE,
  GOOGLE_GMAIL_MODIFY_SCOPE,
  GOOGLE_GMAIL_READ_SCOPE,
} from "@/lib/connectors/google-workspace-capabilities";

const grant = {
  id: "grant-google",
  tenantId: "tenant-a",
  actorId: "actor-a",
  provider: "google" as const,
  scopes: [GOOGLE_GMAIL_MODIFY_SCOPE],
  status: "active" as const,
  authorizationGeneration: 1,
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("active Google Workspace access", () => {
  it("refuses a stale native Calendar authorization before token refresh", async () => {
    mocks.getOAuthGrantSecrets.mockResolvedValue({ grant: { ...grant, accountEmail: "owner@example.test", scopes: [GOOGLE_CALENDAR_EVENTS_READ_SCOPE], authorizationGeneration: 4 },
      tokens: { access_token: "expired-token", refresh_token: "refresh-token" }, credentialState: "refresh_required" });
    await expect(getActiveGoogleWorkspaceAccess({ tenantId: grant.tenantId, actorId: grant.actorId, connectionId: grant.id,
      capability: "calendar.events.read", expectedAuthorizationGeneration: 3, expectedAccountEmail: "owner@example.test" })).rejects.toMatchObject({ code: "account_identity_changed" });
    expect(mocks.refreshOAuthAccess).not.toHaveBeenCalled(); expect(mocks.saveOAuthGrant).not.toHaveBeenCalled();
  });
  it("refuses a changed Calendar account even when its generation matches", async () => {
    mocks.getOAuthGrantSecrets.mockResolvedValue({ grant: { ...grant, accountEmail: "other@example.test", scopes: [GOOGLE_CALENDAR_EVENTS_READ_SCOPE] },
      tokens: { access_token: "active-token" }, credentialState: "active" });
    await expect(getActiveGoogleWorkspaceAccess({ tenantId: grant.tenantId, actorId: grant.actorId, connectionId: grant.id,
      capability: "calendar.events.read", expectedAuthorizationGeneration: 1, expectedAccountEmail: "owner@example.test" })).rejects.toMatchObject({ code: "account_identity_changed" });
    expect(mocks.refreshOAuthAccess).not.toHaveBeenCalled();
  });
  it("returns an active exact-owner token after capability validation", async () => {
    mocks.getOAuthGrantSecrets.mockResolvedValue({
      grant,
      tokens: { access_token: "active-token" },
      credentialState: "active",
    });

    await expect(getActiveGoogleWorkspaceAccess({
      tenantId: "tenant-a",
      actorId: "actor-a",
      capability: "gmail.trash",
    })).resolves.toEqual({ accessToken: "active-token", grant });
    expect(mocks.refreshOAuthAccess).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token without replacing the grant", async () => {
    mocks.getOAuthGrantSecrets.mockResolvedValue({
      grant: { ...grant, authorizationGeneration: 3 },
      tokens: { access_token: "expired-token", refresh_token: "refresh-token" },
      credentialState: "refresh_required",
    });
    mocks.refreshOAuthAccess.mockResolvedValue({
      access_token: "refreshed-token",
      refresh_token: "refresh-token",
      expires_in: 3_600,
    });
    mocks.saveOAuthGrant.mockResolvedValue(grant);

    await expect(getActiveGoogleWorkspaceAccess({
      tenantId: "tenant-a",
      actorId: "actor-a",
      capability: "gmail.send",
    })).resolves.toEqual({ accessToken: "refreshed-token", grant });
    // Only the grant the refresh token was read from, at that authorization.
    expect(mocks.saveOAuthGrant).toHaveBeenCalledWith(expect.objectContaining({
      authorizationMode: "refresh",
      connectionId: "grant-google",
      expectedAuthorizationGeneration: 3,
    }));
  });

  it("never returns or refreshes a token for a connection other than the requested one", async () => {
    for (const credentialState of ["active", "refresh_required"] as const) {
      mocks.getOAuthGrantSecrets.mockResolvedValueOnce({
        grant: { ...grant, id: "grant-google-other-account" },
        tokens: { access_token: "other-account-token", refresh_token: "other-refresh" },
        credentialState,
      });

      await expect(getActiveGoogleWorkspaceAccess({
        tenantId: "tenant-a",
        actorId: "actor-a",
        connectionId: grant.id,
        capability: "gmail.send",
      })).rejects.toMatchObject({ code: "grant_not_found" });
    }
    expect(mocks.getOAuthGrantSecrets).toHaveBeenCalledWith(
      "tenant-a",
      "actor-a",
      "google",
      { connectionId: grant.id },
    );
    expect(mocks.refreshOAuthAccess).not.toHaveBeenCalled();
    expect(mocks.saveOAuthGrant).not.toHaveBeenCalled();
  });

  it("fails before opening the provider when capability is not granted", async () => {
    mocks.getOAuthGrantSecrets.mockResolvedValue({
      grant,
      tokens: { access_token: "active-token" },
      credentialState: "active",
    });

    await expect(getActiveGoogleWorkspaceAccess({
      tenantId: "tenant-a",
      actorId: "actor-a",
      capability: "drive.write",
    })).rejects.toMatchObject({
      code: "capability_not_granted",
      message: "The Google connection is not yet allowed to make Google Drive changes. The owner can allow them from Connections.",
    });
    expect(mocks.refreshOAuthAccess).not.toHaveBeenCalled();
  });

  it("tells the owner where to allow a change a read-only connection cannot make", async () => {
    for (const [scopes, capability, message] of [
      [
        [GOOGLE_GMAIL_READ_SCOPE],
        "gmail.send",
        "The Google connection is not yet allowed to make Gmail changes. The owner can allow them from Connections.",
      ],
      [
        [GOOGLE_CALENDAR_EVENTS_READ_SCOPE],
        "calendar.events.write",
        "The Google connection is not yet allowed to make Google Calendar changes. The owner can allow them from Connections.",
      ],
      // Reading is part of every new connection, so reconnecting restores it.
      [[], "gmail.read", "The Google connection does not grant the required capability."],
    ] as const) {
      mocks.getOAuthGrantSecrets.mockResolvedValue({
        grant: { ...grant, scopes: [...scopes] },
        tokens: { access_token: "active-token" },
        credentialState: "active",
      });
      await expect(getActiveGoogleWorkspaceAccess({
        tenantId: "tenant-a",
        actorId: "actor-a",
        capability,
      }), capability).rejects.toMatchObject({ code: "capability_not_granted", message });
    }
    expect(mocks.refreshOAuthAccess).not.toHaveBeenCalled();
  });
});
