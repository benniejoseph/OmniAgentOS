import {
  getMobileIdentityFromRequest,
  MobileRefreshError,
  recordMobileSessionSeen,
} from "@/lib/auth/mobile";
import type { MobileIdentity } from "@/lib/auth/mobile-types";
import {
  mobileClientAttestationFromHeaders,
  mobileError,
  mobileNoStoreHeaders,
  publicMobileIdentity,
} from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { canPerform, rbacRules } from "@/lib/security/context";
import {
  nativeClientCompatibility,
  nativeClientPolicy,
} from "@/lib/auth/native-client-contract";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const identity = await getMobileIdentityFromRequest(request);
  if (!identity) return mobileError(401, "unauthorized", "A valid bearer token is required.");
  const attestation = mobileClientAttestationFromHeaders(request);
  if (!attestation.success) {
    return mobileError(400, "invalid_request", "The native client attestation is invalid.");
  }
  if (
    attestation.client &&
    attestation.client.platform !== identity.session.device.platform
  ) {
    return mobileError(400, "invalid_request", "The native client platform does not match this session.");
  }
  let observedIdentity: MobileIdentity;
  try {
    observedIdentity = await recordMobileSessionSeen(
      identity,
      attestation.client,
    );
  } catch (error) {
    if (error instanceof MobileRefreshError) {
      return mobileError(401, "unauthorized", "The native session is no longer active.");
    }
    throw error;
  }
  return Response.json({
    authenticated: true,
    ...publicMobileIdentity(observedIdentity),
    permissions: rbacRules.filter((rule) => canPerform(observedIdentity.context.role, rule.action)).map((rule) => rule.action),
    api: { version: 1, basePath: "/api", mobileBasePath: "/api/mobile" },
    client: nativeClientCompatibility(observedIdentity.session.device, {
      clientAttestedAt: observedIdentity.session.clientAttestedAt,
    }),
    nativeClientPolicy: nativeClientPolicy(),
  }, { headers: mobileNoStoreHeaders });
}
