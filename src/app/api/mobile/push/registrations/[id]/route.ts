import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { revokeMobilePushDevice } from "@/lib/mobile/push-store";
import { authorizeRequest } from "@/lib/security/guard";
import {
  mobilePushErrorResponse,
  requireMobilePushIdempotencyKey,
} from "@/lib/mobile/push-http";

export const runtime = "nodejs";
export const DELETE = withDatabaseRequestScope(DELETEHandler);

async function DELETEHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  try {
    const context = await authorizeRequest({
      request,
      action: "read.identity",
      resourceType: "mobile_push_registration",
      resourceId: id,
      nativeMutationCapability: "push.registration.update",
    });
    const registration = await revokeMobilePushDevice(
      context,
      id,
      requireMobilePushIdempotencyKey(request),
    );
    return registration
      ? Response.json(
          { schemaVersion: 1, registration },
          { headers: mobileNoStoreHeaders },
        )
      : Response.json(
          { error: { code: "not_found", message: "The push registration was not found." } },
          { status: 404, headers: mobileNoStoreHeaders },
        );
  } catch (error) {
    return mobilePushErrorResponse(error);
  }
}
