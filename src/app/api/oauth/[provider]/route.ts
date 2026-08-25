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
  try {
    const secrets = await getOAuthGrantSecrets(security.tenantId, security.actorId, provider);
    if (secrets) {
      const providerToken = String(secrets.tokens.refresh_token || secrets.tokens.access_token || "");
      await revokeOAuthAccess(provider, providerToken);
    }
    await revokeOAuthGrant(security.tenantId, security.actorId, provider);
    return Response.json(
      { revoked: true, provider, providerRevoked: Boolean(secrets) },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "OAuth access could not be revoked." },
      { status: 502 },
    );
  }
}
