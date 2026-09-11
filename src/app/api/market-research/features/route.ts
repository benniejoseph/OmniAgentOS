import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showMarketResearchFeaturesService } from "@/lib/app-services/market-research";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { marketTechnicalFeaturesQuerySchema } from "@/lib/market-research/contracts";
import {
  MarketPriceSnapshotNotFoundError,
  MarketPriceSnapshotStoreUnavailableError,
} from "@/lib/market-research/price-snapshot-store";
import { MarketTechnicalInsufficientDataError } from "@/lib/market-research/technical-features";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 20;
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "market_technical_features",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const parsed = marketTechnicalFeaturesQuerySchema.safeParse({
    snapshotId: url.searchParams.get("snapshotId") || undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid market-feature request." }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }

  try {
    const result = await showMarketResearchFeaturesService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    if (error instanceof MarketPriceSnapshotNotFoundError) {
      return Response.json({ error: error.message }, {
        status: 404,
        headers: privateNoStoreHeaders,
      });
    }
    if (
      error instanceof MarketPriceSnapshotStoreUnavailableError ||
      error instanceof MarketTechnicalInsufficientDataError
    ) {
      return Response.json({ error: error.message }, {
        status: 409,
        headers: privateNoStoreHeaders,
      });
    }
    console.error(
      "Market technical features failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json({ error: "Market technical features are temporarily unavailable." }, {
      status: 503,
      headers: privateNoStoreHeaders,
    });
  }
}
