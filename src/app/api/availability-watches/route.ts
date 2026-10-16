import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey, requiredRequestIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest } from "@/lib/security/guard";
import { AVAILABILITY_WATCH_CONTRACT, AvailabilityWatchError } from "@/lib/availability-watches/contracts";
import { watchDenial, watchFailure, watchHeaders, watchOwner, watchQuery } from "@/lib/availability-watches/http";
import { createAvailabilityWatch, listAvailabilityWatches } from "@/lib/availability-watches/service";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "availability_watch" }); }
  catch (error) { return watchDenial(error); }
  try {
    const query = watchQuery(request, ["limit"]); const value = query.get("limit");
    if (value !== null && !/^(?:[1-9][0-9]?|100)$/.test(value)) throw new AvailabilityWatchError("Choose a list limit from 1 to 100.");
    return Response.json(await listAvailabilityWatches({ ...watchOwner(context), ...(value === null ? {} : { limit: Number(value) }) }), { headers: watchHeaders });
  } catch (error) { return watchFailure(error); }
}
async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "availability_watch", nativeMutationCapability: "availability.watches.manage" }); }
  catch (error) { return watchDenial(error); }
  try {
    watchQuery(request);
    const watch = await createAvailabilityWatch(await parseJsonBody(request, 8_192), { ...watchOwner(context), requestId: requiredRequestIdempotencyKey(request) });
    return Response.json({ schemaVersion: 1, contract: AVAILABILITY_WATCH_CONTRACT, watch }, { headers: watchHeaders });
  } catch (error) { return watchFailure(error); }
}
