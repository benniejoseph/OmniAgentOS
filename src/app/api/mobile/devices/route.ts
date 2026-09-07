import { listMobileDeviceSessions } from "@/lib/auth/mobile";
import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { nativeDeviceListResponseSchema } from "@/lib/mobile/contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "owned_mobile_devices",
    });
    const devices = await listMobileDeviceSessions(context);
    return Response.json(nativeDeviceListResponseSchema.parse(devices), {
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
