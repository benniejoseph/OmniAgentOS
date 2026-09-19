const PLUGIN_IDEMPOTENCY_KEY =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/;

export function pluginIdempotencyErrorResponse(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim() || "";
  if (PLUGIN_IDEMPOTENCY_KEY.test(value)) return undefined;
  return Response.json(
    {
      error:
        "Plugin mutations require an opaque Idempotency-Key header of 512 characters or fewer.",
    },
    {
      status: 400,
      headers: { "cache-control": "private, no-store" },
    },
  );
}
