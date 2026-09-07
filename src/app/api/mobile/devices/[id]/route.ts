import { changeMobileDeviceLifecycle } from "@/lib/auth/mobile";
import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  nativeDeviceLifecycleRequestSchema,
  nativeDeviceSessionSchema,
} from "@/lib/mobile/contracts";
import { recordSecurityAudit } from "@/lib/security/audit-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 2_048);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = nativeDeviceLifecycleRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: { code: "invalid_request", message: "The device lifecycle request is invalid." } },
      { status: 400, headers: mobileNoStoreHeaders },
    );
  }
  const { id } = await route.params;
  try {
    const context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "owned_mobile_device",
      resourceId: id,
      metadata: { action: parsed.data.action },
    });
    const device = await changeMobileDeviceLifecycle(
      context,
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
      context,
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
  } catch (error) {
    const response = forbiddenResponse(error);
    for (const [name, value] of Object.entries(mobileNoStoreHeaders)) {
      response.headers.set(name, value);
    }
    return response;
  }
}
