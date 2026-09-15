export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";

export function enforcePrivateNoStore(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", PRIVATE_NO_STORE_CACHE_CONTROL);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
