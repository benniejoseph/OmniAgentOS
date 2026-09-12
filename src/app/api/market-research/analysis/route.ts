import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  generateMarketAnalysisVersionService,
  listMarketAnalysisVersionsService,
} from "@/lib/app-services/market-research";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  marketAnalysisGenerateRequestSchema,
  marketAnalysisVersionsQuerySchema,
} from "@/lib/market-research/contracts";
import { MarketAnalysisStoreUnavailableError } from "@/lib/market-research/analysis-store";
import {
  MarketPriceSnapshotNotFoundError,
  MarketPriceSnapshotStoreUnavailableError,
} from "@/lib/market-research/price-snapshot-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 20;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "market_analysis_version",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = marketAnalysisVersionsQuerySchema.safeParse({
    instrumentId: url.searchParams.get("instrumentId") || undefined,
    interval: url.searchParams.get("interval") || undefined,
    limit: numericQuery(url.searchParams.get("limit"), 10),
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid saved market-analysis request." }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }
  try {
    const result = await listMarketAnalysisVersionsService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    console.error("Saved market analyses failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Saved market analyses are temporarily unavailable." }, {
      status: 503,
      headers: privateNoStoreHeaders,
    });
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = marketAnalysisGenerateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid market-analysis save request.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "market_analysis_version",
      metadata: {
        operation: "generate",
        snapshotId: parsed.data.snapshotId,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await generateMarketAnalysisVersionService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "market.analysis_version.generate",
      }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      status: result.data.reused ? 200 : 201,
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
      error instanceof MarketAnalysisStoreUnavailableError ||
      error instanceof MarketPriceSnapshotStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, {
        status: 409,
        headers: privateNoStoreHeaders,
      });
    }
    console.error("Market analysis save failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "The market analysis could not be saved." }, {
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
