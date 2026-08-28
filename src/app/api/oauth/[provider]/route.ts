import { isOAuthProvider, revokeOAuthAccess } from "@/lib/connectors/oauth-providers";
import { getOAuthGrantSecrets, revokeOAuthGrant } from "@/lib/connectors/oauth-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const DELETE = withDatabaseRequestScope(DELETEHandler);
async function DELETEHandler(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider)) return Response.json({ error: "Unsupported OAuth provider." }, { status: 404 });
  let security;
  try { security = await authorizeRequest({ request, action: "write.memory", resourceType: "oauth_grant", metadata: { provider, operation: "revoke" } }); } catch (error) { return forbiddenResponse(error); }

  let providerToken = "";
  let providerRevocation: "revoked" | "not_needed" | "failed" = "not_needed";
  try {
    const secrets = await getOAuthGrantSecrets(security.tenantId, security.actorId, provider);
    if (secrets) {
      providerToken = String(secrets.tokens.refresh_token || secrets.tokens.access_token || "");
    }
  } catch {
    providerRevocation = "failed";
  }

  try {
    // Seal the local grant before relying on a remote provider request. A slow or
    // unavailable provider must never leave the local connection active.
    await revokeOAuthGrant(security.tenantId, security.actorId, provider);
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
