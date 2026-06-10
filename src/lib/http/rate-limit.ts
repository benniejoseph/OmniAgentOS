// Instance-local sliding-window rate limiter. On serverless this bounds each
// instance rather than the global rate; it is a cost/abuse backstop, not a
// strict quota. Swap for a shared store (e.g. Postgres/Upstash) for hard limits.
const windows = new Map<string, number[]>();

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
