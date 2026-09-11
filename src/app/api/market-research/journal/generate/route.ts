import { generateMarketForecastService } from "@/lib/app-services/market-research";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { marketForecastGenerateRequestSchema } from "@/lib/market-research/contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = marketForecastGenerateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid market forecast generation request.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "market_forward_forecast",
      metadata: {
        operation: "generate",
        instrumentId: parsed.data.instrumentId,
        horizon: parsed.data.horizon,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await generateMarketForecastService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "market.forward_forecast.generate",
      }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      status: result.data.reused ? 200 : 201,
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    console.error("Market forecast generation failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json({
      error: "Market scenario generation failed. Check the configured model and exact price feed, then try again.",
    }, { status: 503, headers: privateNoStoreHeaders });
  }
}
