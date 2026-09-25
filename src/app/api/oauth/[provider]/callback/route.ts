import {
  exchangeOAuthCode,
  googleConnectorAccountPolicyForIdentity,
  isOAuthProvider,
  normalizeOAuthReturnTo,
  openOAuthState,
} from "@/lib/connectors/oauth-providers";
import { saveOAuthGrant } from "@/lib/connectors/oauth-store";
import { oauthProviders } from "@/lib/connectors/oauth-providers";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { getAppBaseUrl } from "@/lib/config";
import { resolveSalesforceRequestAccess } from "@/lib/customer-success/salesforce-access";
import { bindSalesforceConnection } from "@/lib/customer-success/salesforce-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider)) return Response.json({ error: "Unsupported OAuth provider." }, { status: 404 });
  let security;
  try { security = await authorizeRequest({ request, action: provider === "salesforce" ? "manage.connector" : "write.memory", resourceType: "oauth_grant", metadata: { provider, operation: "callback" } }); } catch (error) { return forbiddenResponse(error); }
  const url = new URL(request.url); const code = url.searchParams.get("code"); const stateValue = url.searchParams.get("state");
  let returnTo = "/app/connectors";
  if (stateValue) {
    try { returnTo = openOAuthState(provider, stateValue).returnTo; }
    catch { returnTo = normalizeOAuthReturnTo(undefined); }
  }
  if (!code || !stateValue) return Response.redirect(oauthResultUrl(returnTo, "denied", provider), 302);
  try {
    const state = openOAuthState(provider, stateValue);
    if (state.tenantId !== security.tenantId) throw new Error("OAuth tenant changed during authorization.");
    if (provider === "google" && state.googleConnectionPurpose === "work") {
      throw new Error("The retired side-by-side Work connection cannot be authorized.");
    }
    const googleConnectionPurpose = "personal" as const;
    const googleConnectorAccount = provider === "google"
      ? googleConnectorAccountPolicyForIdentity({
          email: security.auth?.email || "",
          tenantId: security.tenantId,
        })
      : undefined;
    if (
      provider === "google" &&
      state.googleAccountEmail !== googleConnectorAccount?.email
    ) {
      throw new Error("Google account identity changed during authorization.");
    }
    const tokens = await exchangeOAuthCode(
      provider,
      code,
      state.verifier,
      provider === "google"
        ? { googleConnectionPurpose, googleConnectorAccount }
        : undefined,
    );
    if (provider === "salesforce") {
      const access = await resolveSalesforceRequestAccess(security, {
        workspaceId: state.workspaceId || undefined,
        mode: "write",
        correlationId: crypto.randomUUID(),
      });
      if (state.actorId !== access.readAuthority.canonicalActorId ||
          state.workspaceId !== access.readAuthority.workspaceId) {
        throw new Error("OAuth workspace identity changed during authorization.");
      }
      const grant = await saveOAuthGrant({
        tenantId: security.tenantId,
        actorId: access.readAuthority.canonicalActorId,
        provider,
        tokens: {
          ...tokens,
          scope: typeof tokens.scope === "string"
            ? tokens.scope
            : oauthProviders.salesforce.scopes.join(" "),
        },
      });
      await bindSalesforceConnection({
        authority: access.mutationAuthority!,
        oauthGrantId: grant.id,
        authorizationGeneration: grant.authorizationGeneration,
        tokens,
      });
    } else {
      if (state.actorId !== security.actorId) throw new Error("OAuth identity changed during authorization.");
      const accountPolicy = googleConnectorAccount!;
      await saveOAuthGrant({
        tenantId: security.tenantId,
        actorId: security.actorId,
        provider,
        tokens,
        connectionId: state.connectionId || undefined,
        connectionPurpose: accountPolicy.purpose,
        connectionLabel: accountPolicy.label,
        accountEmail: accountPolicy.email,
      });
    }
    return Response.redirect(oauthResultUrl(state.returnTo, "connected", provider), 302);
  } catch { return Response.redirect(oauthResultUrl(returnTo, "failed", provider), 302); }
}

function oauthResultUrl(returnTo: string, status: "connected" | "denied" | "failed", provider: string) {
  const result = new URL(normalizeOAuthReturnTo(returnTo), getAppBaseUrl());
  result.searchParams.set("oauth", status);
  if (status === "connected") result.searchParams.set("provider", provider);
  return result.toString();
}
