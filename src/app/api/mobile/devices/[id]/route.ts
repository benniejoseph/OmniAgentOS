import {
  changeMobileDeviceLifecycle,
  getMobileIdentityFromRequest,
} from "@/lib/auth/mobile";
import { mobileError, mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import {
  enterDatabaseTenantContext,
  withDatabaseRequestScope,
} from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import {
  nativeDeviceLifecycleRequestSchema,
  nativeDeviceSessionSchema,
} from "@/lib/mobile/contracts";
import { recordSecurityAudit } from "@/lib/security/audit-store";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 2_048);
  } catch {
    return mobileError(
      400,
      "invalid_request",
      "The device lifecycle request is invalid.",
    );
  }
  const parsed = nativeDeviceLifecycleRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: { code: "invalid_request", message: "The device lifecycle request is invalid." } },
      { status: 400, headers: mobileNoStoreHeaders },
    );
  }
  const { id } = await route.params;
  const identity = await getMobileIdentityFromRequest(request);
  if (!identity) {
    return mobileError(
      401,
      "unauthorized",
      "A valid bearer token is required.",
    );
  }
  enterDatabaseTenantContext(identity.context.tenantId);
  const device = await changeMobileDeviceLifecycle(
    identity.context,
    id,
    parsed.data.action,
  );
  if (!device) {
    return Response.json(
      { error: { code: "not_found", message: "The device session was not found." } },
      { status: 404, headers: mobileNoStoreHeaders },
    );
  }
  await recordSecurityAudit({
    context: identity.context,
    action: parsed.data.action === "remote_wipe"
      ? "security.mobile_remote_wipe_requested"
      : "security.mobile_session_revoked",
    resourceType: "mobile_session",
    resourceId: id,
    decision: "allow",
    metadata: {
      current: device.current,
      localErasure: device.wipe?.localErasure || "not_requested",
    },
  });
  return Response.json(nativeDeviceSessionSchema.parse(device), {
    headers: mobileNoStoreHeaders,
  });
}
