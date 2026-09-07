import { z } from "zod";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { updateTodayItemService } from "@/lib/app-services/today";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const updateSchema = z.object({
  title: z.string().trim().min(1).max(280).optional(),
  status: z.enum(["open", "done"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  dueAt: z.string().datetime().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "A change is required.",
});

async function PATCHHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid focus item update", details: parsed.error.flatten() }, { status: 400 });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "today_item",
      resourceId: id,
      nativeMutationCapability: "today.update",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await updateTodayItemService(
    createRequestMutationAppServiceCaller(request, context, { purpose: "today.item.update", causationId: id }),
    { itemId: id, ...parsed.data },
  );
  return result.data.item
    ? Response.json({ ...result.data, serviceReceipt: result.receipt })
    : Response.json({ error: "Focus item not found." }, { status: 404 });
}
