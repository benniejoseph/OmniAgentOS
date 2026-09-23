import { isOAuthProvider } from "@/lib/connectors/oauth-providers";
import { syncPersonalProvider } from "@/lib/connectors/personal-sync";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider) || provider !== "google") return Response.json({ error: "Unsupported personal-source provider." }, { status: 404 });
  let security;
  try { security = await authorizeRequest({ request, action: "write.memory", resourceType: "oauth_sync", metadata: { provider } }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const requestedSource = new URL(request.url).searchParams.get("source");
    const connectionId = new URL(request.url).searchParams.get("connectionId") || undefined;
    if (requestedSource && requestedSource !== "calendar") {
      return Response.json({ error: "Unsupported sync source." }, { status: 400 });
    }
    return Response.json(await syncPersonalProvider({ tenantId: security.tenantId, actorId: security.actorId, provider, connectionId, sources: requestedSource ? ["calendar"] : undefined, abortSignal: request.signal }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Connected source sync failed." }, { status: 502 });
  }
}
