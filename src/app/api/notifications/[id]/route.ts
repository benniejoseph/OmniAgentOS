import { z } from "zod";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { updateNotificationService } from "@/lib/app-services/notifications";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

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
      nativeMutationCapability: "notifications.update",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await updateNotificationService(
      createRequestMutationAppServiceCaller(request, context, { purpose: "notification.update", causationId: id }),
      { notificationId: id, action: parsed.data.action, minutes: parsed.data.action === "snooze" ? parsed.data.minutes : undefined },
    );
    return result.data.notification
      ? Response.json({ ...result.data, serviceReceipt: result.receipt })
      : Response.json({ error: "Notification not found." }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Notification update failed.";
    return Response.json(
      { error: message },
      { status: message.startsWith("Idempotency-Key") ? 400 : 409 },
    );
  }
}
