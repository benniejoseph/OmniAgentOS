import {
  createOAuthAuthorization,
  isOAuthProvider,
  normalizeOAuthReturnTo,
} from "@/lib/connectors/oauth-providers";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider)) return Response.json({ error: "Unsupported OAuth provider." }, { status: 404 });
  let security;
  try { security = await authorizeRequest({ request, action: "write.memory", resourceType: "oauth_grant", metadata: { provider } }); } catch (error) { return forbiddenResponse(error); }
  const returnTo = normalizeOAuthReturnTo(new URL(request.url).searchParams.get("returnTo"));
  try { return Response.redirect(createOAuthAuthorization(provider, { tenantId: security.tenantId, actorId: security.actorId, returnTo }), 302); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "OAuth authorization failed." }, { status: 503 }); }
}
