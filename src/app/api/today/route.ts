import { z } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createTodayItemService, showTodayService } from "@/lib/app-services/today";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const createSchema = z.object({
  title: z.string().trim().min(1).max(280),
  kind: z.enum(["task", "reminder"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  dueAt: z.string().datetime().optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "today" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await showTodayService(createAppServiceCaller({ context }), {});
  return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
    headers: { "cache-control": "private, no-store" },
  });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid focus item", details: parsed.error.flatten() }, { status: 400 });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "today_item",
      nativeMutationCapability: "today.update",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await createTodayItemService(
    createRequestMutationAppServiceCaller(request, context, { purpose: "today.item.create" }),
    parsed.data,
  );
  return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: 201 });
}
