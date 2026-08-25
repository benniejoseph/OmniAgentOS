import { exchangeOAuthCode, isOAuthProvider, openOAuthState } from "@/lib/connectors/oauth-providers";
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
  if (!code || !stateValue) return Response.redirect(`${getAppBaseUrl()}/app/connectors?oauth=denied`, 302);
  try {
    const state = openOAuthState(provider, stateValue);
    if (state.tenantId !== security.tenantId || state.actorId !== security.actorId) throw new Error("OAuth identity changed during authorization.");
    const tokens = await exchangeOAuthCode(provider, code, state.verifier);
    await saveOAuthGrant({ tenantId: security.tenantId, actorId: security.actorId, provider, tokens });
    return Response.redirect(`${getAppBaseUrl()}/app/connectors?oauth=connected&provider=${provider}`, 302);
  } catch { return Response.redirect(`${getAppBaseUrl()}/app/connectors?oauth=failed`, 302); }
}
