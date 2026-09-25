import {
  createOAuthAuthorization,
  googleConnectorAccountPolicyForIdentity,
  type GoogleConnectionPurpose,
  type GoogleConnectorAccountPolicy,
  isOAuthProvider,
  normalizeOAuthReturnTo,
  oauthConfigured,
  oauthProviders,
} from "@/lib/connectors/oauth-providers";
import { getOAuthGrantSecrets } from "@/lib/connectors/oauth-store";
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
  if (!oauthConfigured(provider)) {
    return Response.json(
      { error: `${oauthProviders[provider].label} OAuth is not configured.` },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
  const requestUrl = new URL(request.url);
  const returnTo = normalizeOAuthReturnTo(requestUrl.searchParams.get("returnTo"));
  const authorizationIntent = requestUrl.searchParams.get("intent") === "repair"
    ? "repair" as const
    : undefined;
  if (provider === "google" && requestUrl.searchParams.get("account") === "work") {
    return Response.json(
      {
        error: "Work is a separate Asael account. Switch accounts before connecting Google Workspace.",
      },
      { status: 409, headers: { "cache-control": "private, no-store" } },
    );
  }
  const googleConnectionPurpose: GoogleConnectionPurpose = "personal";
  const requestedConnectionId = requestUrl.searchParams.get("connectionId") || undefined;
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
    if (!security.auth?.email) {
      return Response.json(
        { error: "Google Workspace connection requires a signed-in private account." },
        { status: 403, headers: { "cache-control": "private, no-store" } },
      );
    }
    let googleConnectorAccount: GoogleConnectorAccountPolicy;
    try {
      googleConnectorAccount = googleConnectorAccountPolicyForIdentity({
        email: security.auth.email,
        tenantId: security.tenantId,
      });
    } catch {
      return Response.json(
        { error: "This Asael account is not permitted to connect Google." },
        { status: 403, headers: { "cache-control": "private, no-store" } },
      );
    }
    if (requestedConnectionId) {
      const existing = await getOAuthGrantSecrets(
        security.tenantId,
        security.actorId,
        provider,
        {
          connectionId: requestedConnectionId,
          connectionPurpose: googleConnectionPurpose,
        },
      );
      if (!existing) {
        return Response.json(
          { error: "The selected Google account connection was not found." },
          { status: 404, headers: { "cache-control": "private, no-store" } },
        );
      }
    }
    return Response.redirect(createOAuthAuthorization(provider, {
      tenantId: security.tenantId,
      actorId: security.actorId,
      returnTo,
      googleConnectionPurpose,
      googleConnectorAccount,
      ...(requestedConnectionId ? { connectionId: requestedConnectionId } : {}),
      ...(authorizationIntent ? { authorizationIntent } : {}),
    }), 302);
  }
  catch (error) {
    // This page is opened by top-level navigation, so never echo a database,
    // sealing, or provider failure into the browser.
    console.error(
      "OAuth authorization failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "OAuth authorization is temporarily unavailable." },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
