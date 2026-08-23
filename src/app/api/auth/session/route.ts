import { getSessionToken } from "@/lib/auth/session";
import { getSessionIdentity, isAuthEnforced, isBootstrapConfigured } from "@/lib/auth/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { measureRequestStage } from "@/lib/observability/request-timing";
import { getSecurityContext } from "@/lib/security/context";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const identity = await measureRequestStage("auth", () =>
    getSessionIdentity(getSessionToken(request))
  );
  const authEnabled = isAuthEnforced();

  return Response.json({
    authEnabled,
    bootstrapConfigured: isBootstrapConfigured(),
    authenticated: Boolean(identity),
    context: identity?.context || (!authEnabled ? getSecurityContext(request) : undefined),
    user: identity?.user,
    tenant: identity?.tenant,
    membership: identity?.membership,
  });
}
