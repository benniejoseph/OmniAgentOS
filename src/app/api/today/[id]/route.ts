import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { updateTodayItem } from "@/lib/today/store";

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
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "today_item", resourceId: id });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const item = await updateTodayItem(id, parsed.data, {
    tenantId: context.tenantId,
    actorId: context.actorId,
  });
  return item
    ? Response.json({ item })
    : Response.json({ error: "Focus item not found." }, { status: 404 });
}
