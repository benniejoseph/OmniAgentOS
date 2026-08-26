import { getSessionToken } from "@/lib/auth/session";
import { getSessionIdentity, isAuthEnforced, isBootstrapConfigured } from "@/lib/auth/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { measureRequestStage } from "@/lib/observability/request-timing";
import { getSecurityContext } from "@/lib/security/context";
import { googleOwnerLoginConfigured } from "@/lib/auth/google";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const identity = await measureRequestStage("auth", () =>
    getSessionIdentity(getSessionToken(request))
  );
  const authEnabled = isAuthEnforced();
  // Trusted internal callers use the same signed identity headers as the
  // protected APIs. Exposing that verified context here lets headless release
  // checks exercise the real authenticated workspace without a password-only
  // session or a mocked browser response.
  const headerContext = identity ? undefined : getSecurityContext(request);
  const trustedHeaderContext =
    headerContext?.source === "headers" ? headerContext : undefined;
  const context = identity?.context || trustedHeaderContext;

  return Response.json({
    authEnabled,
    bootstrapConfigured: isBootstrapConfigured(),
    googleLoginConfigured: googleOwnerLoginConfigured(),
    authenticated: Boolean(identity || trustedHeaderContext),
    context: context || (!authEnabled ? headerContext : undefined),
    user: identity?.user,
    tenant: identity?.tenant,
    membership:
      identity?.membership ||
      (trustedHeaderContext ? { role: trustedHeaderContext.role } : undefined),
  });
}
