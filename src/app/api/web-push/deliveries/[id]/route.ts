import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest } from "@/lib/security/guard";
import { parseJsonBody } from "@/lib/http/body";
import { watchFailure,watchDenial,watchHeaders } from "@/lib/availability-watches/http";
import { browserReceiptSchema } from "@/lib/web-push/contracts";
import { browserDelivery } from "@/lib/web-push/store";
export const runtime = "nodejs";
async function handler(request:Request,route:{ params:Promise<{ id:string }> }) {
  let context;
  try { context = await authorizeRequest({ request,action:"manage.own_device",resourceType:"browser_push_delivery" }); }
  catch (error) { return watchDenial(error); }
  try {
    const { id } = await route.params;
    const receipt = request.method === "POST" ? browserReceiptSchema.parse({ ...await parseJsonBody(request,1024) as object,id }).kind : undefined;
    browserReceiptSchema.shape.id.parse(id);
    return Response.json(await browserDelivery(context,id,receipt),{ headers:watchHeaders });
  } catch (error) { return watchFailure(error); }
}
export const GET = withDatabaseRequestScope(handler);
export const POST = withDatabaseRequestScope(handler);
