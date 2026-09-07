import { parseJsonBody } from "@/lib/http/body";
import {
  nativePushRegistrationListResponseSchema,
  nativePushRegistrationRequestSchema,
  nativePushRegistrationResponseSchema,
} from "@/lib/mobile/contracts";
import {
  listMobilePushDevices,
  registerMobilePushDevice,
} from "@/lib/mobile/push-store";
import {
  mobilePushError,
  mobilePushErrorResponse,
  requireMobilePushIdempotencyKey,
} from "@/lib/mobile/push-http";
import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

async function GETHandler(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "read.identity",
      resourceType: "mobile_push_registration",
    });
    return Response.json(
      nativePushRegistrationListResponseSchema.parse(
        await listMobilePushDevices(context),
      ),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return mobilePushErrorResponse(error);
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 8_192);
  } catch {
    return mobilePushError(400, "invalid_request", "The push registration request is invalid.");
  }
  const parsed = nativePushRegistrationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return mobilePushError(400, "invalid_request", "The push registration request is invalid.");
  }
  try {
    const context = await authorizeRequest({
      request,
      action: "read.identity",
      resourceType: "mobile_push_registration",
      nativeMutationCapability: "push.registration.update",
    });
    const idempotencyKey = requireMobilePushIdempotencyKey(request);
    return Response.json(
      nativePushRegistrationResponseSchema.parse(
        await registerMobilePushDevice(context, {
          ...parsed.data,
          idempotencyKey,
        }),
      ),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return mobilePushErrorResponse(error);
  }
}
