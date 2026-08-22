import { getSessionToken } from "@/lib/auth/session";
import { getAuthControlPlane, getSessionIdentity, isAuthEnforced, isBootstrapConfigured } from "@/lib/auth/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { getSecurityContext } from "@/lib/security/context";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const identity = await getSessionIdentity(getSessionToken(request));
  const authEnabled = isAuthEnforced();
  const controlPlane = identity ? await getAuthControlPlane({ tenantId: identity.tenant.id }) : undefined;

  return Response.json({
    authEnabled,
    bootstrapConfigured: isBootstrapConfigured(),
    authenticated: Boolean(identity),
    context: identity?.context || (!authEnabled ? getSecurityContext(request) : undefined),
    user: identity?.user,
    tenant: identity?.tenant,
    membership: identity?.membership,
    stats: controlPlane?.stats,
  });
}
