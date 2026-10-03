export type PublicHealth = { status: "healthy" | "degraded" | "unhealthy" | "unavailable"; checkedAt?: string };

/** An HTTP error cannot become healthy; the health route uses 503 for a known unhealthy report. */
export function parsePublicHealth(statusCode: number, value: unknown): PublicHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "unavailable" };
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (!((statusCode === 200 && (status === "healthy" || status === "degraded" || status === "unhealthy")) ||
    (statusCode === 503 && status === "unhealthy"))) return { status: "unavailable" };
  const checkedAt = typeof record.checkedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.checkedAt) &&
    Number.isFinite(Date.parse(record.checkedAt)) && new Date(record.checkedAt).toISOString() === record.checkedAt ? record.checkedAt : undefined;
  return { status, ...(checkedAt ? { checkedAt } : {}) };
}
