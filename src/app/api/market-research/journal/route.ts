import { listMarketForecastJournalService } from "@/lib/app-services/market-research";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { marketForecastJournalQuerySchema } from "@/lib/market-research/contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "market_forecast_journal",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = marketForecastJournalQuerySchema.safeParse({
    instrumentId: url.searchParams.get("instrumentId") || undefined,
    limit: numericQuery(url.searchParams.get("limit"), 40),
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid market forecast journal request." }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }
  try {
    const result = await listMarketForecastJournalService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    console.error("Market forecast journal failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "The market forecast journal is temporarily unavailable." }, {
      status: 503,
      headers: privateNoStoreHeaders,
    });
  }
}

function numericQuery(value: string | null, fallback: number) {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
