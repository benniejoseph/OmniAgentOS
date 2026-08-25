import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { updatePersonalNotification } from "@/lib/today/notifications";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
  z.object({ action: z.literal("complete") }).strict(),
  z.object({
    action: z.literal("snooze"),
    minutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60), z.literal(120), z.literal(1440)]).optional(),
  }).strict(),
]);

async function PATCHHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid notification action", details: parsed.error.flatten() }, { status: 400 });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "personal_notification",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const notification = await updatePersonalNotification(id, parsed.data.action, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    snoozeMinutes: parsed.data.action === "snooze" ? parsed.data.minutes : undefined,
  });
  return notification
    ? Response.json({ notification })
    : Response.json({ error: "Notification not found." }, { status: 404 });
}
