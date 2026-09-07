import { z } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { listNotificationsService, readAllNotificationsService } from "@/lib/app-services/notifications";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

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
  const result = await listNotificationsService(createAppServiceCaller({ context }), {});
  return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "private, no-store" } });
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
  try {
    const result = await readAllNotificationsService(
      createRequestMutationAppServiceCaller(request, context, { purpose: "notification.read_all", causationId: "notifications:read_all" }),
      {},
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt });
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
