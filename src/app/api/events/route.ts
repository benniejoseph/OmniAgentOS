import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { listRecentEvents, listStreamEvents } from "@/lib/events/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "domain_event",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const streamId = url.searchParams.get("stream")?.slice(0, 240) || undefined;
  const type = url.searchParams.get("type")?.slice(0, 160) || undefined;
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, {
    max: 200,
  });

  if (streamId) {
    return Response.json({
      stream: streamId,
      events: await listStreamEvents(streamId, { tenantId: context.tenantId, limit }),
    });
  }

  return Response.json({
    events: await listRecentEvents({ tenantId: context.tenantId, limit, type }),
  });
}
