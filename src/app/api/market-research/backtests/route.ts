import {
  listMarketBacktestsService,
  runMarketBacktestService,
} from "@/lib/app-services/market-research";
import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  marketBacktestRequestSchema,
  marketBacktestsQuerySchema,
} from "@/lib/market-research/contracts";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
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
      resourceType: "market_backtest",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = marketBacktestsQuerySchema.safeParse({
    instrumentId: url.searchParams.get("instrumentId") || undefined,
    limit: numericQuery(url.searchParams.get("limit"), 20),
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid market backtest request." }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }
  try {
    const result = await listMarketBacktestsService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    console.error("Market backtest list failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Market backtests are temporarily unavailable." }, {
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
  const parsed = marketBacktestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid market backtest request.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "market_backtest",
      nativeMutationCapability: "markets.backtest.run",
      metadata: {
        operation: "run",
        snapshotId: parsed.data.snapshotId,
        strategyId: parsed.data.strategy.strategyId,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await runMarketBacktestService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "market.backtest.run.queue",
      }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      status: 202,
      headers: {
        ...privateNoStoreHeaders,
        location: `/api/operations/jobs/${result.data.job.id}`,
        "retry-after": "2",
      },
    });
  } catch (error) {
    console.error("Market backtest queue failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Market backtest could not be queued." }, {
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
