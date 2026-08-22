import { createHash } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";

// Instance-local sliding-window rate limiter. On serverless this bounds each
// instance rather than the global rate; it is a cost/abuse backstop, not a
// strict quota. Production request paths should use checkSharedRateLimit.
const windows = new Map<string, number[]>();
let sharedChecksSinceCleanup = 0;

export class RateLimitStoreUnavailableError extends Error {
  constructor(message = "The shared rate-limit store is unavailable.") {
    super(message);
    this.name = "RateLimitStoreUnavailableError";
  }
}

export function checkRateLimit({
  key,
  limit,
  windowMs = 60_000,
}: {
  key: string;
  limit: number;
  windowMs?: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const cutoff = now - windowMs;
  const entries = (windows.get(key) || []).filter((timestamp) => timestamp > cutoff);

  if (entries.length >= limit) {
    const oldest = Math.min(...entries);
    windows.set(key, entries);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  entries.push(now);
  windows.set(key, entries);
  if (windows.size > 10_000) {
    windows.clear();
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Atomic fixed-window limiter shared by every application instance. Local
 * development falls back to the in-memory sliding window when Postgres is not
 * configured; deployed environments fail closed if the shared store fails.
 */
export async function checkSharedRateLimit(input: {
  key: string;
  limit: number;
  windowMs?: number;
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const windowMs = input.windowMs ?? 60_000;
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new Error("Rate-limit count must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("Rate-limit window must be a positive safe integer.");
  }

  if (!hasDatabaseUrl()) {
    return checkRateLimit({ ...input, windowMs });
  }

  const now = new Date();
  const resetCutoff = new Date(now.getTime() - windowMs);
  const expiresAt = new Date(now.getTime() + windowMs);
  const keyHash = createHash("sha256").update(input.key).digest("hex");

  try {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      INSERT INTO omni_rate_limits (
        key_hash, window_started_at, request_count, expires_at, updated_at
      )
      VALUES (${keyHash}, ${now}, 1, ${expiresAt}, ${now})
      ON CONFLICT (key_hash) DO UPDATE SET
        window_started_at = CASE
          WHEN omni_rate_limits.window_started_at <= ${resetCutoff}
            THEN ${now}
          ELSE omni_rate_limits.window_started_at
        END,
        request_count = CASE
          WHEN omni_rate_limits.window_started_at <= ${resetCutoff}
            THEN 1
          ELSE omni_rate_limits.request_count + 1
        END,
        expires_at = ${expiresAt},
        updated_at = ${now}
      RETURNING request_count, window_started_at
    `;

    sharedChecksSinceCleanup += 1;
    if (sharedChecksSinceCleanup >= 100) {
      sharedChecksSinceCleanup = 0;
      await getSql()`
        DELETE FROM omni_rate_limits
        WHERE key_hash IN (
          SELECT key_hash
          FROM omni_rate_limits
          WHERE expires_at < ${now}
          ORDER BY expires_at ASC
          LIMIT 500
        )
      `;
    }

    const count = Number(rows[0]?.request_count || 0);
    const windowStartedAt = new Date(String(rows[0]?.window_started_at || now.toISOString())).getTime();
    return {
      allowed: count <= input.limit,
      retryAfterSeconds:
        count <= input.limit
          ? 0
          : Math.max(1, Math.ceil((windowStartedAt + windowMs - now.getTime()) / 1000)),
    };
  } catch (error) {
    throw new RateLimitStoreUnavailableError(
      error instanceof Error
        ? `The shared rate-limit store is unavailable: ${error.message}`
        : undefined,
    );
  }
}
