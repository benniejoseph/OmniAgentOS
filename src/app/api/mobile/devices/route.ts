import {
  getMobileIdentityFromRequest,
  listMobileDeviceSessions,
} from "@/lib/auth/mobile";
import {
  mobileError,
  mobileNoStoreHeaders,
} from "@/lib/auth/mobile-http";
import {
  enterDatabaseTenantContext,
  withDatabaseRequestScope,
} from "@/lib/db/client";
import { nativeDeviceListResponseSchema } from "@/lib/mobile/contracts";
import { recordSecurityAudit } from "@/lib/security/audit-store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const identity = await getMobileIdentityFromRequest(request);
  if (!identity) {
    return mobileError(
      401,
      "unauthorized",
      "A valid bearer token is required.",
    );
  }
  enterDatabaseTenantContext(identity.context.tenantId);
  const devices = await listMobileDeviceSessions(identity.context);
  await recordSecurityAudit({
    context: identity.context,
    action: "security.mobile_devices_listed",
    resourceType: "mobile_session",
    decision: "allow",
    metadata: { count: devices.devices.length },
  });
  return Response.json(nativeDeviceListResponseSchema.parse(devices), {
    headers: mobileNoStoreHeaders,
  });
}
