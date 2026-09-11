import {
  createOAuthAuthorization,
  isOAuthProvider,
  normalizeOAuthReturnTo,
} from "@/lib/connectors/oauth-providers";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { resolveSalesforceRequestAccess } from "@/lib/customer-success/salesforce-access";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider)) return Response.json({ error: "Unsupported OAuth provider." }, { status: 404 });
  let security;
  try { security = await authorizeRequest({ request, action: provider === "salesforce" ? "manage.connector" : "write.memory", resourceType: "oauth_grant", metadata: { provider } }); } catch (error) { return forbiddenResponse(error); }
  const requestUrl = new URL(request.url);
  const returnTo = normalizeOAuthReturnTo(requestUrl.searchParams.get("returnTo"));
  const authorizationIntent = requestUrl.searchParams.get("intent") === "repair"
    ? "repair" as const
    : undefined;
  try {
    if (provider === "salesforce") {
      const access = await resolveSalesforceRequestAccess(security, {
        workspaceId: new URL(request.url).searchParams.get("workspaceId") || undefined,
        mode: "write",
        correlationId: crypto.randomUUID(),
      });
      return Response.redirect(createOAuthAuthorization(provider, {
        tenantId: security.tenantId,
        actorId: access.readAuthority.canonicalActorId,
        workspaceId: access.readAuthority.workspaceId,
        returnTo,
      }), 302);
    }
    return Response.redirect(createOAuthAuthorization(provider, {
      tenantId: security.tenantId,
      actorId: security.actorId,
      returnTo,
      ...(authorizationIntent ? { authorizationIntent } : {}),
    }), 302);
  }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "OAuth authorization failed." }, { status: 503 }); }
}
