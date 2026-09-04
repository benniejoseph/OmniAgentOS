import { oauthConfigured, oauthProviders } from "@/lib/connectors/oauth-providers";
import {
  OAuthGrantReadConflictError,
  listOAuthGrants,
  listOAuthGrantsForRequest,
} from "@/lib/connectors/oauth-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request) {
  let security;
  try { security = await authorizeRequest({ request, action: "read", resourceType: "oauth_grant" }); } catch (error) { return forbiddenResponse(error); }
  const readable = new URL(request.url).searchParams.get("ownerScope") === "readable";
  try {
    const grants = readable
      ? await listOAuthGrantsForRequest({
          tenantId: security.tenantId,
          actorId: security.actorId,
          requestActorBinding:
            canonicalRequestActorBindingFromSecurityContext(security),
        })
      : (await listOAuthGrants(security.tenantId, security.actorId)).map(
          (grant) => ({ ...grant, manageable: true }),
        );
    return Response.json({
      providers: Object.entries(oauthProviders).map(([id, config]) => ({
        id,
        label: config.label,
        scopes: config.scopes,
        configured: oauthConfigured(id as "google"),
        authorizeUrl: `/api/oauth/${id}/authorize`,
      })),
      grants,
      requestReadContracts: {
        oauthGrants: readable ? "readable_v1" : "exact_v1",
      },
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const conflict = error instanceof OAuthGrantReadConflictError;
    if (!conflict) {
      console.error(
        "OAuth connection metadata read failed.",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    return Response.json(
      {
        error: conflict
          ? "OAuth connection metadata could not be resolved safely."
          : "OAuth connections are temporarily unavailable.",
      },
      {
        status: conflict ? 409 : 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}
