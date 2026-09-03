import { getMobileIdentityFromRequest } from "@/lib/auth/mobile";
import { mobileError, mobileNoStoreHeaders, publicMobileIdentity } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { canPerform, rbacRules } from "@/lib/security/context";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const identity = await getMobileIdentityFromRequest(request);
  if (!identity) return mobileError(401, "unauthorized", "A valid bearer token is required.");
  return Response.json({
    authenticated: true,
    ...publicMobileIdentity(identity),
    permissions: rbacRules.filter((rule) => canPerform(identity.context.role, rule.action)).map((rule) => rule.action),
    api: { version: 1, basePath: "/api", mobileBasePath: "/api/mobile" },
  }, { headers: mobileNoStoreHeaders });
}
