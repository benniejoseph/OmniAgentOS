import {
  OAuthCredentialError,
  getOAuthGrantSecrets,
  saveOAuthGrant,
  type NormalizedOAuthGrant,
} from "@/lib/connectors/oauth-store";
import { refreshOAuthAccess } from "@/lib/connectors/oauth-providers";
import {
  hasGoogleWorkspaceCapability,
  type GoogleWorkspaceCapability,
} from "@/lib/connectors/google-workspace-capabilities";

/**
 * Opens or refreshes a Google access token for an exact actor-owned grant and
 * verifies the requested Workspace capability before the caller reaches a
 * provider API. Tokens never leave this server-only connector boundary.
 */
export async function getActiveGoogleWorkspaceAccess(input: {
  tenantId: string;
  actorId: string;
  connectionId?: string;
  capability: GoogleWorkspaceCapability;
}): Promise<Readonly<{ accessToken: string; grant: NormalizedOAuthGrant }>> {
  const secrets = await getOAuthGrantSecrets(
    input.tenantId,
    input.actorId,
    "google",
    input.connectionId ? { connectionId: input.connectionId } : undefined,
  );
  if (!secrets) {
    throw new OAuthCredentialError(
      "The Google connection was not found.",
      "grant_not_found",
    );
  }
  if (!hasGoogleWorkspaceCapability(secrets.grant.scopes, input.capability)) {
    throw new OAuthCredentialError(
      "The Google connection does not grant the required capability.",
      "capability_not_granted",
    );
  }
  const accessToken = tokenString(secrets.tokens.access_token);
  if (secrets.credentialState === "active" && accessToken) {
    return { accessToken, grant: secrets.grant };
  }
  const refreshToken = tokenString(secrets.tokens.refresh_token);
  if (!refreshToken) {
    throw new OAuthCredentialError(
      "The Google connection needs to be reconnected.",
      "credential_missing",
    );
  }
  const refreshed = await refreshOAuthAccess("google", refreshToken);
  const grant = await saveOAuthGrant({
    tenantId: input.tenantId,
    actorId: input.actorId,
    provider: "google",
    connectionId: secrets.grant.id,
    connectionPurpose: secrets.grant.connectionPurpose,
    connectionLabel: secrets.grant.connectionLabel,
    accountEmail: secrets.grant.accountEmail,
    tokens: refreshed,
    authorizationMode: "refresh",
  });
  return { accessToken: String(refreshed.access_token), grant };
}

function tokenString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
