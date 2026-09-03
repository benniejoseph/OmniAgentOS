import { z } from "zod";
import type { MobileDevice } from "@/lib/auth/mobile-types";

export const mobileDeviceSchema = z.object({
  id: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  name: z.string().trim().min(1).max(120),
  platform: z.enum(["android", "ios"]),
  appVersion: z.string().trim().min(1).max(40).optional(),
}).strict();

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
