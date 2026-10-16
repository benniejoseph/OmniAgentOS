import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest } from "@/lib/security/guard";
import { parseJsonBody } from "@/lib/http/body";
import { watchFailure, watchDenial, watchHeaders } from "@/lib/availability-watches/http";
import { browserRegistrationSchema, browserRegistrationIdSchema } from "@/lib/web-push/contracts";
import { listBrowserPush, registerBrowserPush, revokeBrowserPush, queueBrowserPushTest } from "@/lib/web-push/store";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request:Request) => {
  try { const context = await authorizeRequest({ request,action:"manage.own_device",resourceType:"browser_push_registration" });
    return Response.json(await listBrowserPush(context),{ headers:watchHeaders });
  } catch (error) { const denied=watchDenial(error); return denied.status === 500 ? watchFailure(error) : denied; }
});
const actionSchema = z.discriminatedUnion("action",[
  browserRegistrationSchema.extend({ action:z.literal("register") }),
  z.object({ action:z.literal("disable"),id:browserRegistrationIdSchema }).strict(),
  z.object({ action:z.literal("test"),id:browserRegistrationIdSchema,requestId:z.string().uuid() }).strict(),
]);
export const POST = withDatabaseRequestScope(async (request:Request) => {
  let context;
  try { context = await authorizeRequest({ request,action:"manage.own_device",resourceType:"browser_push_registration" }); }
  catch (error) { return watchDenial(error); }
  try {
    const value = actionSchema.parse(await parseJsonBody(request,8192));
    const result = value.action === "register" ? await registerBrowserPush(context,value.subscription)
      : value.action === "disable" ? await revokeBrowserPush(context,value.id) : await queueBrowserPushTest(context,value.id,value.requestId);
    return Response.json(result,{ headers:watchHeaders });
  } catch (error) { return watchFailure(error); }
});
