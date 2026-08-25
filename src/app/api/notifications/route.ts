import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  getNotificationCenter,
  markAllNotificationsRead,
} from "@/lib/today/notifications";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const updateSchema = z.object({ action: z.literal("read_all") }).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "personal_notifications" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const center = await getNotificationCenter({
    tenantId: context.tenantId,
    actorId: context.actorId,
  });
  return Response.json(center, { headers: { "cache-control": "private, no-store" } });
}

async function PATCHHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid notification update", details: parsed.error.flatten() }, { status: 400 });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "personal_notifications" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const notifications = await markAllNotificationsRead({
    tenantId: context.tenantId,
    actorId: context.actorId,
  });
  return Response.json({ notifications, updated: notifications.length });
}
