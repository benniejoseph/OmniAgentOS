import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { loadTodaySnapshot } from "@/lib/today/snapshot";
import { invalidateTodaySnapshot } from "@/lib/today/snapshot-cache";
import { createTodayItem } from "@/lib/today/store";

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
  const snapshot = await loadTodaySnapshot({
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  return Response.json(snapshot, {
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
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "today_item" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const item = await createTodayItem({
    tenantId: context.tenantId,
    actorId: context.actorId,
    ...parsed.data,
  });
  invalidateTodaySnapshot(context);
  return Response.json({ item }, { status: 201 });
}
