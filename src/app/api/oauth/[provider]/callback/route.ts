import {
  exchangeOAuthCode,
  googleConnectorAccountPolicyForIdentity,
  isOAuthProvider,
  normalizeOAuthReturnTo,
  openOAuthState,
} from "@/lib/connectors/oauth-providers";
import { saveOAuthGrant } from "@/lib/connectors/oauth-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { getAppBaseUrl } from "@/lib/config";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider)) return Response.json({ error: "Unsupported OAuth provider." }, { status: 404 });
  let security;
  try { security = await authorizeRequest({ request, action: "write.memory", resourceType: "oauth_grant", metadata: { provider, operation: "callback" } }); } catch (error) { return forbiddenResponse(error); }
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
    const googleConnectorAccount = googleConnectorAccountPolicyForIdentity({
      email: security.auth?.email || "",
      tenantId: security.tenantId,
    });
    if (state.googleAccountEmail !== googleConnectorAccount.email) {
      throw new Error("Google account identity changed during authorization.");
    }
    const tokens = await exchangeOAuthCode(
      provider,
      code,
      state.verifier,
      { googleConnectionPurpose, googleConnectorAccount },
    );
    if (state.actorId !== security.actorId) throw new Error("OAuth identity changed during authorization.");
    await saveOAuthGrant({
      tenantId: security.tenantId,
      actorId: security.actorId,
      provider,
      tokens,
      connectionId: state.connectionId || undefined,
      connectionPurpose: googleConnectorAccount.purpose,
      connectionLabel: googleConnectorAccount.label,
      accountEmail: googleConnectorAccount.email,
    });
    return Response.redirect(oauthResultUrl(state.returnTo, "connected", provider), 302);
  } catch { return Response.redirect(oauthResultUrl(returnTo, "failed", provider), 302); }
}

function oauthResultUrl(returnTo: string, status: "connected" | "denied" | "failed", provider: string) {
  const result = new URL(normalizeOAuthReturnTo(returnTo), getAppBaseUrl());
  result.searchParams.set("oauth", status);
  if (status === "connected") result.searchParams.set("provider", provider);
  return result.toString();
}
