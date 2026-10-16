import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest } from "@/lib/security/guard";
import { watchDenial, watchFailure, watchHeaders, watchOwner, watchQuery } from "@/lib/availability-watches/http";
import { getAvailabilityWatchReadiness } from "@/lib/availability-watches/readiness";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request,route: { params: Promise<{ id:string }> }) => {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request,action:"read",resourceType:"availability_watch",resourceId:id }); }
  catch (error) { return watchDenial(error); }
  try { watchQuery(request); return Response.json(await getAvailabilityWatchReadiness(id,watchOwner(context)),{ headers:watchHeaders }); }
  catch (error) { return watchFailure(error); }
});
