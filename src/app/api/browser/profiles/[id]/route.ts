export const runtime = "nodejs";

export const PATCH = isolatedBrowserRetiredResponse;
export const DELETE = isolatedBrowserRetiredResponse;

function isolatedBrowserRetiredResponse() {
  return Response.json(
    {
      code: "isolated_browser_retired",
      error: "Isolated Browser has been retired. Use This Mac for Computer Use.",
    },
    {
      status: 410,
      headers: { "cache-control": "private, no-store" },
    },
  );
}
