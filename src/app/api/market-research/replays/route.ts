import {
  backfillMarketResearchReplaysService,
  listMarketResearchReplaysService,
} from "@/lib/app-services/market-research";
import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  marketEventReplayRequestSchema,
  marketEventReplaysQuerySchema,
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
      resourceType: "market_event_replay",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = marketEventReplaysQuerySchema.safeParse({
    instrumentId: url.searchParams.get("instrumentId") || undefined,
    limit: numericQuery(url.searchParams.get("limit"), 100),
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid market replay request." }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }
  try {
    const result = await listMarketResearchReplaysService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    console.error("Market replay list failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Market replays are temporarily unavailable." }, {
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
  const parsed = marketEventReplayRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid market replay backfill request.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "market_event_replay",
      nativeMutationCapability: "markets.update",
      metadata: {
        operation: "backfill",
        instrumentId: parsed.data.instrumentId,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        maxEvents: parsed.data.maxEvents,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await backfillMarketResearchReplaysService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "market.replays.backfill.queue",
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
    console.error("Market replay backfill queue failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Market replay backfill could not be queued." }, {
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
