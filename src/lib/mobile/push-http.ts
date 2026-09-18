import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import {
  MobilePushConflictError,
  MobilePushStorageRequiredError,
} from "@/lib/mobile/push-store";
import { forbiddenResponse } from "@/lib/security/guard";

export function requireMobilePushIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim() || "";
  if (!value || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(
      "Idempotency-Key must use 1-200 letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }
  return value;
}

export function mobilePushErrorResponse(error: unknown) {
  const forbidden = forbiddenResponse(error);
  if (forbidden.status !== 500) {
    for (const [name, value] of Object.entries(mobileNoStoreHeaders)) {
      forbidden.headers.set(name, value);
    }
    return forbidden;
  }
  const message = error instanceof Error
    ? error.message
    : "Mobile push request failed.";
  const status = error instanceof MobilePushStorageRequiredError ||
      error instanceof MobilePushConflictError
    ? error.status
    : message.startsWith("Idempotency-Key") ||
        message.includes("token is invalid") ||
        message.startsWith("Push receipt observedAt")
      ? 400
      : message.includes("not eligible") || message.includes("requires an iOS")
        ? 409
        : 503;
  return mobilePushError(
    status,
    status === 503 ? "unavailable" : "invalid_request",
    message,
  );
}

export function mobilePushError(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message } },
    { status, headers: mobileNoStoreHeaders },
  );
}
