import type { MobileDevice } from "@/lib/auth/mobile-types";
import type { SecurityContext } from "@/lib/security/types";
import {
  NATIVE_API_CURRENT_VERSION,
  NATIVE_API_PREVIOUS_VERSION,
  NATIVE_API_SUPPORTED_VERSIONS,
  nativeClientAttestationSchema,
  nativeDeviceSchema,
} from "@/lib/mobile/contracts";

export const mobileClientAttestationSchema = nativeClientAttestationSchema;
export const mobileDeviceSchema = nativeDeviceSchema;

export function mobileClientAttestationFromHeaders(request: Request) {
  const values = {
    platform: request.headers.get("x-asael-native-platform"),
    appVersion: request.headers.get("x-asael-native-app-version"),
    buildNumber: request.headers.get("x-asael-native-build-number"),
    clientContractVersion: request.headers.get(
      "x-asael-native-contract-version",
    ),
  };
  if (Object.values(values).every((value) => value === null)) {
    return { success: true as const, client: undefined };
  }
  if (
    !values.platform ||
    !values.appVersion ||
    !values.buildNumber ||
    !values.clientContractVersion ||
    !/^[1-9][0-9]{0,9}$/.test(values.buildNumber) ||
    !/^[1-9][0-9]{0,9}$/.test(values.clientContractVersion)
  ) {
    return { success: false as const };
  }
  const parsed = mobileClientAttestationSchema.safeParse({
    platform: values.platform,
    appVersion: values.appVersion,
    buildNumber: Number(values.buildNumber),
    clientContractVersion: Number(values.clientContractVersion),
  });
  return parsed.success
    ? { success: true as const, client: parsed.data }
    : { success: false as const };
}

export const mobileNoStoreHeaders = {
  "cache-control": "private, no-store",
  "pragma": "no-cache",
  "x-asael-native-contract-version": String(NATIVE_API_CURRENT_VERSION),
  "x-asael-native-previous-contract-version": String(NATIVE_API_PREVIOUS_VERSION),
  "x-asael-native-supported-contract-versions": NATIVE_API_SUPPORTED_VERSIONS.join(","),
};

export function mobileError(
  status: number,
  code: string,
  message: string,
  headers: HeadersInit = {},
) {
  return Response.json(
    { error: { code, message } },
    { status, headers: { ...mobileNoStoreHeaders, ...headers } },
  );
}

export function publicMobileIdentity(identity: {
  context: SecurityContext;
  user: unknown;
  tenant: unknown;
  membership: unknown;
  session: { device: MobileDevice };
}) {
  const publicContext = {
    tenantId: identity.context.tenantId,
    actorId: identity.context.actorId,
    role: identity.context.role,
    source: identity.context.source,
    auth: identity.context.auth,
  };
  return {
    context: publicContext,
    user: identity.user,
    tenant: identity.tenant,
    membership: identity.membership,
    device: identity.session.device,
  };
}
