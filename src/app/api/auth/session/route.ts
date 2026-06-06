import { getSessionToken } from "@/lib/auth/session";
import { getAuthControlPlane, getSessionIdentity, isAuthEnforced, isBootstrapConfigured } from "@/lib/auth/store";
import { getSecurityContext } from "@/lib/security/context";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const identity = await getSessionIdentity(getSessionToken(request));
  const authEnabled = isAuthEnforced();
  const controlPlane = identity ? await getAuthControlPlane() : undefined;

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
