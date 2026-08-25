import { oauthConfigured, oauthProviders } from "@/lib/connectors/oauth-providers";
import { listOAuthGrants } from "@/lib/connectors/oauth-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request) {
  let security;
  try { security = await authorizeRequest({ request, action: "read", resourceType: "oauth_grant" }); } catch (error) { return forbiddenResponse(error); }
  return Response.json({ providers: Object.entries(oauthProviders).map(([id, config]) => ({ id, label: config.label, scopes: config.scopes, configured: oauthConfigured(id as "google"), authorizeUrl: `/api/oauth/${id}/authorize` })), grants: await listOAuthGrants(security.tenantId, security.actorId) }, { headers: { "cache-control": "private, no-store" } });
}
