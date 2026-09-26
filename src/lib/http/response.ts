export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";

/**
 * An event stream must also stay untransformed: a proxy that compresses it
 * buffers events until the stream ends.
 */
export function privateNoStoreCacheControl(headers: Headers) {
  return headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
    ? `${PRIVATE_NO_STORE_CACHE_CONTROL}, no-transform`
    : PRIVATE_NO_STORE_CACHE_CONTROL;
}

export function enforcePrivateNoStore(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", privateNoStoreCacheControl(headers));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
