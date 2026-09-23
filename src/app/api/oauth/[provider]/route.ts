import { isOAuthProvider, revokeOAuthAccess } from "@/lib/connectors/oauth-providers";
import {
  getOAuthGrantSecrets,
  OAuthGrantReadConflictError,
  revokeOAuthGrant,
} from "@/lib/connectors/oauth-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { resolveSalesforceRequestAccess } from "@/lib/customer-success/salesforce-access";
import { revokeSalesforceConnection } from "@/lib/customer-success/salesforce-store";

export const runtime = "nodejs";
export const DELETE = withDatabaseRequestScope(DELETEHandler);
async function DELETEHandler(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider)) return Response.json({ error: "Unsupported OAuth provider." }, { status: 404 });
  let security;
  try { security = await authorizeRequest({ request, action: provider === "salesforce" ? "manage.connector" : "write.memory", resourceType: "oauth_grant", metadata: { provider, operation: "revoke" } }); } catch (error) { return forbiddenResponse(error); }

  let grantActorId = security.actorId;
  let salesforceAccess: Awaited<ReturnType<typeof resolveSalesforceRequestAccess>> | undefined;
  if (provider === "salesforce") {
    try {
      salesforceAccess = await resolveSalesforceRequestAccess(security, {
        workspaceId: new URL(request.url).searchParams.get("workspaceId") || undefined,
        mode: "write",
        correlationId: crypto.randomUUID(),
      });
      grantActorId = salesforceAccess.readAuthority.canonicalActorId;
    } catch (error) {
      return forbiddenResponse(error);
    }
  }

  let providerToken = "";
  let providerRevocation: "revoked" | "not_needed" | "failed" = "not_needed";
  const connectionId = provider === "google"
    ? new URL(request.url).searchParams.get("connectionId") || undefined
    : undefined;
  let secrets: Awaited<ReturnType<typeof getOAuthGrantSecrets>> = undefined;
  try {
    secrets = await getOAuthGrantSecrets(
      security.tenantId,
      grantActorId,
      provider,
      connectionId ? { connectionId } : undefined,
    );
    if (secrets) {
      providerToken = String(secrets.tokens.refresh_token || secrets.tokens.access_token || "");
    }
  } catch (error) {
    if (error instanceof OAuthGrantReadConflictError) {
      return Response.json(
        { error: "Choose the exact Google account to disconnect." },
        { status: 409, headers: { "cache-control": "private, no-store" } },
      );
    }
    providerRevocation = "failed";
  }

  try {
    // Seal the local grant before relying on a remote provider request. A slow or
    // unavailable provider must never leave the local connection active.
    await revokeOAuthGrant(
      security.tenantId,
      grantActorId,
      provider,
      connectionId ? { connectionId } : undefined,
    );
    if (provider === "salesforce" && salesforceAccess && secrets) {
      await revokeSalesforceConnection({
        authority: salesforceAccess.mutationAuthority!,
        oauthGrantId: secrets.grant.id,
      });
    }
  } catch {
    return Response.json(
      { error: "The local OAuth connection could not be disconnected." },
      { status: 500, headers: { "cache-control": "private, no-store" } },
    );
  }

  if (providerToken) {
    try {
      providerRevocation = await revokeOAuthAccess(provider, providerToken) ? "revoked" : "not_needed";
    } catch {
      providerRevocation = "failed";
    }
  }

  return Response.json(
    {
      revoked: true,
      provider,
      providerRevoked: providerRevocation === "revoked",
      providerRevocation,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
