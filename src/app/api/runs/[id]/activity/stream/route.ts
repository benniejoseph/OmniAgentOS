export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = isolatedBrowserRetiredResponse;

function isolatedBrowserRetiredResponse() {
  return Response.json(
    {
      code: "isolated_browser_retired",
      error: "Isolated Browser activity streaming has been retired.",
    },
    {
      status: 410,
      headers: { "cache-control": "private, no-store" },
    },
  );
}
