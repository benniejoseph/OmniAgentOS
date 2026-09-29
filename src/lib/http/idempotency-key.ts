import { PRIVATE_NO_STORE_CACHE_CONTROL } from "@/lib/http/response";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/;
const SAFE_REQUEST_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export class IdempotencyKeyError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "IdempotencyKeyError";
  }
}

export function isSafeRequestMethod(method: string) {
  return SAFE_REQUEST_METHODS.has(method.toUpperCase());
}

/**
 * The client's Idempotency-Key for a change. The server never makes one up:
 * a generated key, or a request id that each attempt sets afresh, differs on
 * every retry, so a retried change would run again.
 */
export function requiredRequestIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    throw new IdempotencyKeyError(
      "An Idempotency-Key header is required for this change.",
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new IdempotencyKeyError(
      "Idempotency-Key must be an opaque identifier of 512 characters or fewer.",
    );
  }
  return value;
}

export function idempotencyKeyErrorResponse(error: IdempotencyKeyError) {
  return Response.json(
    { error: "Invalid request", message: error.message },
    {
      status: error.status,
      headers: { "cache-control": PRIVATE_NO_STORE_CACHE_CONTROL },
    },
  );
}

/**
 * Refuses a change that arrives without a valid Idempotency-Key before its
 * handler runs, so a route never starts a change it could not repeat safely
 * on retry. Safe methods pass through.
 */
export function requireIdempotencyKey<
  TArgs extends [Request, ...unknown[]],
  TResult,
>(
  handler: (...args: TArgs) => TResult | Promise<TResult>,
): (...args: TArgs) => Promise<TResult | Response> {
  return async (...args) => {
    const [request] = args;
    if (!isSafeRequestMethod(request.method)) {
      try {
        requiredRequestIdempotencyKey(request);
      } catch (error) {
        if (error instanceof IdempotencyKeyError) {
          return idempotencyKeyErrorResponse(error);
        }
        throw error;
      }
    }
    return handler(...args);
  };
}
