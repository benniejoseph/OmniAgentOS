import { getMobileIdentityFromRequest, revokeMobileSession } from "@/lib/auth/mobile";
import { mobileError, mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { enterDatabaseTenantContext, withDatabaseRequestScope } from "@/lib/db/client";
import { recordSecurityAudit } from "@/lib/security/audit-store";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  const identity = await getMobileIdentityFromRequest(request);
  if (!identity) return mobileError(401, "unauthorized", "A valid bearer token is required.");
  enterDatabaseTenantContext(identity.context.tenantId);
  await revokeMobileSession(identity);
  await recordSecurityAudit({ context: identity.context, action: "security.mobile_logout", resourceType: "mobile_session", resourceId: identity.session.id, decision: "allow", metadata: { deviceId: identity.session.device.id } });
  return Response.json({ authenticated: false }, { headers: mobileNoStoreHeaders });
}
