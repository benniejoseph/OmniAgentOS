import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listMarketResearchBarsService } from "@/lib/app-services/market-research";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { marketBarsQuerySchema } from "@/lib/market-research/contracts";
import {
  MarketDataCredentialRequiredError,
  MarketDataProviderError,
  MarketInstrumentMappingRequiredError,
} from "@/lib/market-research/twelve-data";
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
      resourceType: "market_snapshot",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = marketBarsQuerySchema.safeParse({
    instrumentId: url.searchParams.get("instrumentId") || undefined,
    interval: url.searchParams.get("interval") || undefined,
    outputSize: numericQuery(url.searchParams.get("outputSize"), 480),
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid market-bar request.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  try {
    const result = await listMarketResearchBarsService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    if (error instanceof MarketDataCredentialRequiredError) {
      return Response.json({ error: error.message, code: "credential_required" }, {
        status: 503,
        headers: privateNoStoreHeaders,
      });
    }
    if (error instanceof MarketInstrumentMappingRequiredError) {
      return Response.json({ error: error.message, code: "mapping_required" }, {
        status: 409,
        headers: privateNoStoreHeaders,
      });
    }
    if (error instanceof MarketDataProviderError) {
      return Response.json({ error: error.message, code: "provider_unavailable" }, {
        status: 502,
        headers: privateNoStoreHeaders,
      });
    }
    console.error(
      "Market bars failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Market bars are temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}

function numericQuery(value: string | null, fallback: number) {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
