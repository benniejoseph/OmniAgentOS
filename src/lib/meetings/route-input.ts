/** Dynamic params may arrive encoded in direct callers. Decode at most once,
 * bound the work, and leave domain lookup/authority to the existing service. */
export function decodeMeetingRouteId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 720) return undefined;
  try {
    const id = decodeURIComponent(value);
    return id.length > 0 && id.length <= 240 && id.trim() === id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** A route identity cannot be selected or silently overridden by JSON. */
export function isPathScopedMeetingBody(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !Object.hasOwn(value, "meetingId");
}

export function privateMeetingResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  return response;
}
