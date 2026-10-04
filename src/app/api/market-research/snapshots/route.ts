import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listStoredMarketSnapshotsService } from "@/lib/app-services/market-research";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { marketStoredSnapshotsQuerySchema } from "@/lib/market-research/contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "market_snapshot" }); }
  catch (error) { return forbiddenResponse(error); }
  const query = new URL(request.url).searchParams;
  const parsed = marketStoredSnapshotsQuerySchema.safeParse({ instrumentId: query.get("instrumentId") || undefined, interval: query.get("interval") || undefined, limit: query.has("limit") ? Number(query.get("limit")) : undefined });
  if (!parsed.success) return Response.json({ error: "Invalid stored snapshot request." }, { status: 400, headers });
  try {
    const result = await listStoredMarketSnapshotsService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch { return Response.json({ error: "Stored market snapshots are temporarily unavailable." }, { status: 503, headers }); }
}
