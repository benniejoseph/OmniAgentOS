import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest } from "@/lib/security/guard";
import { watchDenial, watchFailure, watchHeaders, watchOwner, watchQuery } from "@/lib/availability-watches/http";
import { getAvailabilityWatch } from "@/lib/availability-watches/service";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "availability_watch", resourceId: id }); }
  catch (error) { return watchDenial(error); }
  try {
    watchQuery(request);
    const { schemaVersion, contract, coverage, watch, checks, hasMore } = await getAvailabilityWatch(id, watchOwner(context));
    // Internal nextPage cursors belong to app.watches.show, not this fixed recent-history contract.
    return Response.json({ schemaVersion, contract, coverage, watch, checks, hasMore }, { headers: watchHeaders });
  } catch (error) { return watchFailure(error); }
}
