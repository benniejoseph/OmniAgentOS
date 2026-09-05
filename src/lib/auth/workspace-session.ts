import { googleOwnerLoginConfigured } from "@/lib/auth/google";
import { getSessionToken } from "@/lib/auth/session";
import {
  getSessionIdentity,
  isAuthEnforced,
  isBootstrapConfigured,
} from "@/lib/auth/store";
import {
  enterDatabaseSecurityContext,
  getSecurityContext,
} from "@/lib/security/context";

export async function resolveWorkspaceSession(request: Request) {
  const identity = await getSessionIdentity(getSessionToken(request));
  const authEnabled = isAuthEnforced();
  const headerContext = identity ? undefined : getSecurityContext(request);
  const trustedHeaderContext = headerContext?.source === "headers"
    ? headerContext
    : undefined;
  const context = identity?.context || trustedHeaderContext;
  if (context) {
    enterDatabaseSecurityContext(context);
  }

  return {
    authEnabled,
    bootstrapConfigured: isBootstrapConfigured(),
    googleLoginConfigured: googleOwnerLoginConfigured(),
    authenticated: Boolean(identity || trustedHeaderContext),
    context: context || (!authEnabled ? headerContext : undefined),
    user: identity?.user,
    tenant: identity?.tenant,
    membership: identity?.membership || (trustedHeaderContext
      ? { role: trustedHeaderContext.role }
      : undefined),
  };
}

export type ResolvedWorkspaceSession = Awaited<ReturnType<typeof resolveWorkspaceSession>>;
