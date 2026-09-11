import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showMarketResearchOverviewService } from "@/lib/app-services/market-research";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "market_research",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await showMarketResearchOverviewService(
      createAppServiceCaller({ context }),
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    console.error(
      "Market research overview failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Market research readiness is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}
