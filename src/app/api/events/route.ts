import { listRecentEvents, listStreamEvents } from "@/lib/events/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
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
  const streamId = url.searchParams.get("stream") || undefined;
  const type = url.searchParams.get("type") || undefined;
  const limit = Number(url.searchParams.get("limit") || 50);

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
