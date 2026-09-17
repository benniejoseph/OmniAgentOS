export const runtime = "nodejs";

export const GET = isolatedBrowserRetiredResponse;
export const POST = isolatedBrowserRetiredResponse;

function isolatedBrowserRetiredResponse() {
  return Response.json(
    {
      code: "isolated_browser_retired",
      error: "Isolated Browser takeover has been retired. Use This Mac for Computer Use.",
    },
    {
      status: 410,
      headers: { "cache-control": "private, no-store" },
    },
  );
}
