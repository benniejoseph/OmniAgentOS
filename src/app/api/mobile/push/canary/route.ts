import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import {
  nativePushCanaryRequestSchema,
  nativePushCanaryResponseSchema,
} from "@/lib/mobile/contracts";
import {
  listMobilePushCanaryTargets,
  runMobilePushReceiptCanary,
} from "@/lib/mobile/push-store";
import {
  mobilePushErrorResponse,
  requireMobilePushIdempotencyKey,
} from "@/lib/mobile/push-http";
import { authorizeRequest } from "@/lib/security/guard";

export const runtime = "nodejs";
// Provider transport may consume 10 seconds before the requested receipt wait
// begins. Keep enough platform margin to return an explicit terminal outcome.
export const maxDuration = 60;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

async function GETHandler(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "mobile_push_canary",
    });
    return Response.json(
      await listMobilePushCanaryTargets(context),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return mobilePushErrorResponse(error);
  }
}

async function POSTHandler(request: Request) {
  let parsed;
  try {
    parsed = nativePushCanaryRequestSchema.safeParse(
      await parseJsonBody(request, 2_048),
    );
  } catch {
    parsed = { success: false } as const;
  }
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: "invalid_request",
          message: "The push canary request is invalid.",
        },
      },
      { status: 400, headers: mobileNoStoreHeaders },
    );
  }
  try {
    const context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "mobile_push_canary",
      nativeMutationCapability: "push.canary.run",
    });
    const result = await runMobilePushReceiptCanary(
      context,
      requireMobilePushIdempotencyKey(request),
      {
        registrationId: parsed.data.registrationId,
        timeoutMs: (parsed.data.timeoutSeconds || 8) * 1_000,
      },
    );
    return Response.json(
      nativePushCanaryResponseSchema.parse(result),
      { headers: mobileNoStoreHeaders },
    );
  } catch (error) {
    return mobilePushErrorResponse(error);
  }
}
