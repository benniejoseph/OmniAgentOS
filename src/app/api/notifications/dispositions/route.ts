import {
  listNotificationDispositionsService,
  notificationDispositionListServiceInputSchema,
} from "@/lib/app-services/notifications";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  NotificationDispositionUnavailableError,
} from "@/lib/mobile/notification-disposition-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const parsed = notificationDispositionListServiceInputSchema.safeParse({
    limit: url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined,
    before: url.searchParams.get("before") || undefined,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid notification disposition query." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "notification_disposition",
      metadata: { operation: "app.notifications.dispositions.list" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await listNotificationDispositionsService(
      createAppServiceCaller({ context: auth }),
      parsed.data,
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    if (error instanceof NotificationDispositionUnavailableError) {
      return Response.json(
        { error: "Notification decision history is temporarily unavailable." },
        { status: 503, headers: privateNoStoreHeaders },
      );
    }
    console.error(
      "Notification disposition history failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Notification decision history failed." },
      { status: 500, headers: privateNoStoreHeaders },
    );
  }
}
