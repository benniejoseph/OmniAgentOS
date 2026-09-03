import { z } from "zod";
import { MAX_PASSWORD_LENGTH, PasswordWorkCapacityError, hashSessionToken } from "@/lib/auth/crypto";
import { authenticateMobilePassword } from "@/lib/auth/mobile";
import { mobileDeviceSchema, mobileError, mobileNoStoreHeaders, publicMobileIdentity } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { getTrustedClientIp } from "@/lib/http/client-ip";
import { checkSharedRateLimit, RateLimitStoreUnavailableError } from "@/lib/http/rate-limit";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  device: mobileDeviceSchema,
}).strict();

async function POSTHandler(request: Request) {
  const ip = getTrustedClientIp(request);
  try {
    const limit = await checkSharedRateLimit({ key: `mobile:login:${ip}`, limit: 30, windowMs: 15 * 60 * 1000 });
    if (!limit.allowed) return mobileError(429, "rate_limited", "Too many sign-in attempts. Try again later.", { "Retry-After": String(limit.retryAfterSeconds) });
    const parsed = schema.safeParse(await parseJsonBody(request, 16_384));
    if (!parsed.success) return mobileError(400, "invalid_request", "The sign-in request is invalid.");
    const accountHash = hashSessionToken(parsed.data.email.trim().toLowerCase());
    const accountLimit = await checkSharedRateLimit({ key: `mobile:login:account:${accountHash}`, limit: 10, windowMs: 15 * 60 * 1000 });
    if (!accountLimit.allowed) return mobileError(429, "rate_limited", "Too many sign-in attempts. Try again later.", { "Retry-After": String(accountLimit.retryAfterSeconds) });
    const result = await authenticateMobilePassword({ ...parsed.data, email: parsed.data.email.trim().toLowerCase() });
    if (!result) return mobileError(401, "invalid_credentials", "Email or password is incorrect, or the account is inactive.");
    return Response.json({ authenticated: true, tokens: result.tokens, ...publicMobileIdentity(result.identity) }, { headers: mobileNoStoreHeaders });
  } catch (error) {
    if (error instanceof PasswordWorkCapacityError || error instanceof RateLimitStoreUnavailableError) {
      return mobileError(503, "authentication_unavailable", "Sign in cannot be safely processed right now.", { "Retry-After": "30" });
    }
    if (error instanceof SyntaxError || (error && typeof error === "object" && "status" in error)) {
      return mobileError(400, "invalid_request", "The sign-in request is invalid.");
    }
    throw error;
  }
}
