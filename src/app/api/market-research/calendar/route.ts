import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showMarketLiveCalendarService } from "@/lib/app-services/market-research";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { marketLiveCalendarQuerySchema } from "@/lib/market-research/contracts";
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
      resourceType: "market_event_history",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const value = new URL(request.url).searchParams.get("days");
  const parsed = marketLiveCalendarQuerySchema.safeParse({
    days: value === null || !value.trim() ? 14 : Number(value),
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid live market calendar request." }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }
  try {
    const result = await showMarketLiveCalendarService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    console.error(
      "Live market calendar failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json({ error: "The official market calendar is temporarily unavailable." }, {
      status: 503,
      headers: privateNoStoreHeaders,
    });
  }
}
