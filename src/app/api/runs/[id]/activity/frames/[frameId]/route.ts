export const runtime = "nodejs";

export const GET = isolatedBrowserRetiredResponse;

function isolatedBrowserRetiredResponse() {
  return Response.json(
    {
      code: "isolated_browser_retired",
      error: "Isolated Browser frame delivery has been retired.",
    },
    {
      status: 410,
      headers: { "cache-control": "private, no-store" },
    },
  );
}
