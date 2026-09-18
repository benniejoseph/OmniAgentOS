import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import {
  mobilePushReceiptRequestSchema,
} from "@/lib/mobile/push-contract";
import {
  nativePushReceiptResponseSchema,
} from "@/lib/mobile/contracts";
import {
  getMobilePushAcknowledgementCandidate,
  recordMobilePushDeliveryReceipt,
} from "@/lib/mobile/push-store";
import {
  mobilePushErrorResponse,
  requireMobilePushIdempotencyKey,
} from "@/lib/mobile/push-http";
import { authorizeRequest } from "@/lib/security/guard";
import { notificationMutationFromRequest } from "@/lib/today/notification-events";
import { updatePersonalNotification } from "@/lib/today/notifications";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  let parsed;
  try {
    parsed = mobilePushReceiptRequestSchema.safeParse(
      await parseJsonBody(request, 4_096),
    );
  } catch {
    parsed = { success: false } as const;
  }
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: "invalid_request",
          message: "The app receipt is invalid.",
        },
      },
      { status: 400, headers: mobileNoStoreHeaders },
    );
  }
  const { id } = await route.params;
  try {
    const context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "mobile_push_delivery_receipt",
      resourceId: id,
      nativeMutationCapability: "push.delivery.receipt",
    });
    const idempotencyKey = requireMobilePushIdempotencyKey(request);
    const candidate = await getMobilePushAcknowledgementCandidate(context, id);
    if (!candidate) {
      return Response.json(
        {
          error: {
            code: "not_found",
            message: "The provider-accepted push was not found for this installation.",
          },
        },
        { status: 404, headers: mobileNoStoreHeaders },
      );
    }
    const opensNotification = parsed.data.kind === "opened" ||
      (parsed.data.kind === "action" && parsed.data.action === "open");
    if (candidate.notificationId && opensNotification) {
      await updatePersonalNotification(candidate.notificationId, "read", {
        tenantId: context.tenantId,
        actorId: context.actorId,
        onlyIfUnread: true,
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
    const recorded = await recordMobilePushDeliveryReceipt(
      context,
      id,
      parsed.data,
      idempotencyKey,
    );
    if (!recorded) {
      return Response.json(
        { error: { code: "not_found", message: "The push was not found." } },
        { status: 404, headers: mobileNoStoreHeaders },
      );
    }
    return Response.json(nativePushReceiptResponseSchema.parse({
      schemaVersion: 1,
      recorded: true,
      newlyRecorded: recorded.newlyRecorded,
      receipt: {
        id: recorded.receipt.id,
        kind: recorded.receipt.kind,
        action: recorded.receipt.action || null,
        observedAt: recorded.receipt.observedAt,
        recordedAt: recorded.receipt.recordedAt,
        appLifecycle: recorded.receipt.appLifecycle,
        platform: recorded.receipt.platform,
      },
      delivery: recorded.delivery,
    }), { headers: mobileNoStoreHeaders });
  } catch (error) {
    return mobilePushErrorResponse(error);
  }
}
