import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey, requiredRequestIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest } from "@/lib/security/guard";
import { AVAILABILITY_WATCH_CONTRACT } from "@/lib/availability-watches/contracts";
import { watchDenial, watchFailure, watchHeaders, watchOwner, watchQuery, watchStopRequestSchema } from "@/lib/availability-watches/http";
import { stopAvailabilityWatch } from "@/lib/availability-watches/service";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "availability_watch", resourceId: id, nativeMutationCapability: "availability.watches.manage" }); }
  catch (error) { return watchDenial(error); }
  try {
    watchQuery(request);
    const input = watchStopRequestSchema.parse(await parseJsonBody(request, 1_024));
    const watch = await stopAvailabilityWatch(id, { ...watchOwner(context), ...input, requestId: requiredRequestIdempotencyKey(request) });
    return Response.json({ schemaVersion: 1, contract: AVAILABILITY_WATCH_CONTRACT, watch }, { headers: watchHeaders });
  } catch (error) { return watchFailure(error); }
}
