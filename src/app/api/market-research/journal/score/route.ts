import { scoreDueMarketForecastsService } from "@/lib/app-services/market-research";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { marketForecastScoreRequestSchema } from "@/lib/market-research/contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = marketForecastScoreRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid market forecast scoring request.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "market_forecast_outcome",
      nativeMutationCapability: "markets.update",
      metadata: {
        operation: "score_due",
        instrumentId: parsed.data.instrumentId,
        maxForecasts: parsed.data.maxForecasts,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await scoreDueMarketForecastsService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "market.forward_forecast.score",
      }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    console.error("Market forecast scoring failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json({
      error: "Due market scenarios could not be scored against the exact feed.",
    }, { status: 503, headers: privateNoStoreHeaders });
  }
}
