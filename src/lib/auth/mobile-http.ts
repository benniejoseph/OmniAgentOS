import { z } from "zod";
import type { MobileDevice } from "@/lib/auth/mobile-types";
import {
  isStableNativeVersion,
} from "@/lib/auth/native-client-contract";

const positiveDatabaseInteger = z.number().int().min(1).max(2_147_483_647);

export const mobileClientAttestationSchema = z.object({
  platform: z.enum(["android", "ios"]),
  appVersion: z.string().min(1).max(40).refine(isStableNativeVersion),
  buildNumber: positiveDatabaseInteger,
  clientContractVersion: positiveDatabaseInteger,
}).strict();

export const mobileDeviceSchema = z.object({
  id: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  name: z.string().trim().min(1).max(120),
  platform: z.enum(["android", "ios"]),
  // appVersion alone is the pre-contract legacy shape. It remains accepted
  // and is classified as unknown rather than being rewritten or trusted.
  appVersion: z.string().min(1).max(40).optional(),
  buildNumber: positiveDatabaseInteger.optional(),
  clientContractVersion: positiveDatabaseInteger.optional(),
}).strict().superRefine((device, context) => {
  const hasBuild = device.buildNumber !== undefined;
  const hasContract = device.clientContractVersion !== undefined;
  if (!hasBuild && !hasContract) return;
  if (
    !hasBuild ||
    !hasContract ||
    !device.appVersion ||
    !isStableNativeVersion(device.appVersion)
  ) {
    context.addIssue({
      code: "custom",
      message: "Native client attestation must include a stable version, build, and contract.",
    });
  }
});

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
  context: unknown;
  user: unknown;
  tenant: unknown;
  membership: unknown;
  session: { device: MobileDevice };
}) {
  return {
    context: identity.context,
    user: identity.user,
    tenant: identity.tenant,
    membership: identity.membership,
    device: identity.session.device,
  };
}
