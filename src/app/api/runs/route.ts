import { listAgentRuns } from "@/lib/runs/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 20);
  return Response.json({
    runs: await listAgentRuns(Math.min(Math.max(limit, 1), 100)),
  });
}
