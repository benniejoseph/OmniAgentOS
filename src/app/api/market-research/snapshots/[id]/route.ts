import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showStoredMarketSnapshotService } from "@/lib/app-services/market-research";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { MarketPriceSnapshotNotFoundError } from "@/lib/market-research/price-snapshot-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  if (!/^market_snapshot_[a-f0-9]{48}$/.test(id)) return Response.json({ error: "Invalid market snapshot identity." }, { status: 400, headers });
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "market_snapshot", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const result = await showStoredMarketSnapshotService(createAppServiceCaller({ context }), id);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof MarketPriceSnapshotNotFoundError ? "Stored market snapshot not found." : "Stored market snapshot is temporarily unavailable." }, { status: error instanceof MarketPriceSnapshotNotFoundError ? 404 : 503, headers });
  }
}
