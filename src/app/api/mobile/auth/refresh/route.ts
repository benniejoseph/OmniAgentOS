import { z } from "zod";
import { MobileRefreshError, rotateMobileRefreshToken } from "@/lib/auth/mobile";
import {
  mobileClientAttestationSchema,
  mobileError,
  mobileNoStoreHeaders,
} from "@/lib/auth/mobile-http";
import { nativeClientCompatibility } from "@/lib/auth/native-client-contract";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { getTrustedClientIp } from "@/lib/http/client-ip";
import { checkSharedRateLimit, RateLimitStoreUnavailableError } from "@/lib/http/rate-limit";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
const schema = z.object({
  refreshToken: z.string().min(32).max(256),
  deviceId: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  client: mobileClientAttestationSchema.optional(),
}).strict();

async function POSTHandler(request: Request) {
  try {
    const limit = await checkSharedRateLimit({ key: `mobile:refresh:${getTrustedClientIp(request)}`, limit: 120, windowMs: 15 * 60 * 1000 });
    if (!limit.allowed) return mobileError(429, "rate_limited", "Too many refresh attempts. Try again later.", { "Retry-After": String(limit.retryAfterSeconds) });
    const parsed = schema.safeParse(await parseJsonBody(request, 8_192));
    if (!parsed.success) return mobileError(400, "invalid_request", "The refresh request is invalid.");
    const rotation = await rotateMobileRefreshToken(
      parsed.data.refreshToken,
      parsed.data.deviceId,
      parsed.data.client,
    );
    return Response.json({
      tokens: rotation.tokens,
      client: nativeClientCompatibility(rotation.session.device, {
        clientAttestedAt: rotation.session.clientAttestedAt,
      }),
    }, { headers: mobileNoStoreHeaders });
  } catch (error) {
    if (error instanceof MobileRefreshError) return mobileError(401, error.code, "The session cannot be refreshed. Sign in again.");
    if (error instanceof RateLimitStoreUnavailableError) return mobileError(503, "authentication_unavailable", "Refresh cannot be safely processed right now.", { "Retry-After": "30" });
    if (error instanceof SyntaxError || (error && typeof error === "object" && "status" in error)) return mobileError(400, "invalid_request", "The refresh request is invalid.");
    throw error;
  }
}
