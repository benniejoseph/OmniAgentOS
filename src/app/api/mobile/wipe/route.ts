import {
  acknowledgeMobileWipe,
  getMobileWipeChallengeFromRequest,
} from "@/lib/auth/mobile";
import { mobileError, mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import {
  nativeWipeAcknowledgementRequestSchema,
  nativeWipeAcknowledgementResponseSchema,
  nativeWipeChallengeResponseSchema,
} from "@/lib/mobile/contracts";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

async function GETHandler(request: Request) {
  const challenge = await getMobileWipeChallengeFromRequest(request);
  if (!challenge) {
    return mobileError(404, "not_found", "No pending device wipe was found.");
  }
  return Response.json(nativeWipeChallengeResponseSchema.parse(challenge), {
    headers: mobileNoStoreHeaders,
  });
}

async function POSTHandler(request: Request) {
  let parsed;
  try {
    parsed = nativeWipeAcknowledgementRequestSchema.safeParse(
      await parseJsonBody(request, 2_048),
    );
  } catch {
    return mobileError(400, "invalid_request", "The wipe acknowledgement is invalid.");
  }
  if (!parsed.success) {
    return mobileError(400, "invalid_request", "The wipe acknowledgement is invalid.");
  }
  const acknowledged = await acknowledgeMobileWipe(
    parsed.data.acknowledgementToken,
    parsed.data.deviceId,
  );
  if (!acknowledged) {
    return mobileError(409, "invalid_wipe_challenge", "The wipe acknowledgement is no longer valid.");
  }
  return Response.json(
    nativeWipeAcknowledgementResponseSchema.parse({ acknowledged: true }),
    { headers: mobileNoStoreHeaders },
  );
}
