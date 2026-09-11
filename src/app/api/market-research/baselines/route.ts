import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showMarketResearchBaselinesService } from "@/lib/app-services/market-research";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { marketEventBaselinesQuerySchema } from "@/lib/market-research/contracts";
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
      resourceType: "market_event_baseline",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const parsed = marketEventBaselinesQuerySchema.safeParse({
    instrumentId: url.searchParams.get("instrumentId") || undefined,
    minimumSampleSize: numericQuery(
      url.searchParams.get("minimumSampleSize"),
      20,
    ),
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid market baseline request." }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }

  try {
    const result = await showMarketResearchBaselinesService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    console.error(
      "Market event baselines failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json({ error: "Market event baselines are temporarily unavailable." }, {
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
