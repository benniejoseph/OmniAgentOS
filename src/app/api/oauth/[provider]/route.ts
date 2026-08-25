import { isOAuthProvider } from "@/lib/connectors/oauth-providers";
import { revokeOAuthGrant } from "@/lib/connectors/oauth-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const DELETE = withDatabaseRequestScope(DELETEHandler);
async function DELETEHandler(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider)) return Response.json({ error: "Unsupported OAuth provider." }, { status: 404 });
  let security;
  try { security = await authorizeRequest({ request, action: "write.memory", resourceType: "oauth_grant", metadata: { provider, operation: "revoke" } }); } catch (error) { return forbiddenResponse(error); }
  await revokeOAuthGrant(security.tenantId, security.actorId, provider);
  return Response.json({ revoked: true, provider }, { headers: { "cache-control": "private, no-store" } });
}
