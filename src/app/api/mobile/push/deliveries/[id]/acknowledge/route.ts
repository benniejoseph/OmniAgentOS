import { parseJsonBody } from "@/lib/http/body";
import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { nativePushAcknowledgementResponseSchema } from "@/lib/mobile/contracts";
import {
  acknowledgeMobilePushDelivery,
  getMobilePushAcknowledgementCandidate,
} from "@/lib/mobile/push-store";
import { notificationMutationFromRequest } from "@/lib/today/notification-events";
import { updatePersonalNotification } from "@/lib/today/notifications";
import { authorizeRequest } from "@/lib/security/guard";
import {
  mobilePushErrorResponse,
  requireMobilePushIdempotencyKey,
} from "@/lib/mobile/push-http";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const body = await parseJsonBody(request, 1_024);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      return Response.json(
        { error: { code: "invalid_request", message: "The acknowledgement body must be empty." } },
        { status: 400, headers: mobileNoStoreHeaders },
      );
    }
  } catch {
    return Response.json(
      { error: { code: "invalid_request", message: "The acknowledgement request is invalid." } },
      { status: 400, headers: mobileNoStoreHeaders },
    );
  }
  const { id } = await route.params;
  try {
    const context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "mobile_push_delivery",
      resourceId: id,
      nativeMutationCapability: "push.delivery.acknowledge",
    });
    const idempotencyKey = requireMobilePushIdempotencyKey(request);
    const candidate = await getMobilePushAcknowledgementCandidate(context, id);
    if (!candidate) {
      return Response.json(
        { error: { code: "not_found", message: "The delivered push notification was not found." } },
        { status: 404, headers: mobileNoStoreHeaders },
      );
    }
    if (candidate.notificationId) {
      await updatePersonalNotification(candidate.notificationId, "read", {
        tenantId: context.tenantId,
        actorId: context.actorId,
        mutation: notificationMutationFromRequest(
          new Request(request.url, {
            headers: new Headers({
              ...Object.fromEntries(request.headers.entries()),
              "idempotency-key": `push-open:${id}`,
            }),
          }),
          context,
          candidate.notificationId,
        ),
      });
    }
    const acknowledged = await acknowledgeMobilePushDelivery(
      context,
      id,
      idempotencyKey,
    );
    if (!acknowledged) {
      return Response.json(
        { error: { code: "not_found", message: "The push notification was not found." } },
        { status: 404, headers: mobileNoStoreHeaders },
      );
    }
    return Response.json(nativePushAcknowledgementResponseSchema.parse({
      schemaVersion: 1,
      acknowledged: true,
      newlyAcknowledged: acknowledged.newlyAcknowledged,
      notificationId: acknowledged.delivery.notificationId || null,
      causeKind: acknowledged.delivery.target.kind,
      causeId: acknowledged.delivery.target.id,
      deepLink: acknowledged.delivery.deepLink,
    }), { headers: mobileNoStoreHeaders });
  } catch (error) {
    return mobilePushErrorResponse(error);
  }
}
