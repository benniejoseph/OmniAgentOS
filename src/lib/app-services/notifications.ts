import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { listNotificationDispositions } from "@/lib/mobile/notification-disposition-store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { getNotificationCenter, markAllNotificationsRead, updatePersonalNotification } from "@/lib/today/notifications";

const notificationListSchema = z.object({}).strict();
export const notificationDispositionListServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
}).strict();
const notificationUpdateSchema = z.object({
  notificationId: z.string().trim().min(1).max(200),
  action: z.enum(["read", "dismiss", "snooze", "complete"]),
  minutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60), z.literal(120), z.literal(1440)]).optional(),
}).strict().superRefine((value, refinement) => {
  if (value.minutes !== undefined && value.action !== "snooze") {
    refinement.addIssue({ code: "custom", path: ["minutes"], message: "minutes is valid only for snooze." });
  }
});
const notificationReadAllSchema = z.object({}).strict();

export async function listNotificationsService(caller: AppServiceCaller, input: z.input<typeof notificationListSchema>) {
  notificationListSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.notifications.list"));
  const center = await getNotificationCenter({ ...readOwner(caller), processDue: false });
  return completeAppServiceCall(authorized, center, { resourceCount: center.notifications.length });
}

export async function listNotificationDispositionsService(
  caller: AppServiceCaller,
  input: z.input<typeof notificationDispositionListServiceInputSchema>,
  dependencies: { list: typeof listNotificationDispositions } = {
    list: listNotificationDispositions,
  },
) {
  const value = notificationDispositionListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.notifications.dispositions.list"),
  );
  const dispositions = await dependencies.list({
    tenantId: caller.context.tenantId,
    ownerActorId: caller.context.actorId,
    limit: value.limit,
    before: value.before,
  });
  return completeAppServiceCall(authorized, {
    version: "notification-disposition-projection:1" as const,
    dispositions,
    contentIncluded: false as const,
  }, { resourceCount: dispositions.length });
}

export async function updateNotificationService(caller: AppServiceCaller, input: z.input<typeof notificationUpdateSchema>) {
  const value = notificationUpdateSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.notifications.update"));
  const notification = await updatePersonalNotification(value.notificationId, value.action, {
    ...exactOwner(caller),
    snoozeMinutes: value.minutes,
    mutation: mutationContext(caller),
  });
  return completeAppServiceCall(authorized, { notification: notification || null }, { resourceCount: notification ? 1 : 0 });
}

export async function readAllNotificationsService(caller: AppServiceCaller, input: z.input<typeof notificationReadAllSchema>) {
  notificationReadAllSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.notifications.read_all"));
  const notifications = await markAllNotificationsRead({ ...exactOwner(caller), mutation: mutationContext(caller) });
  return completeAppServiceCall(authorized, { notifications, updated: notifications.length }, { resourceCount: notifications.length });
}

function exactOwner(caller: AppServiceCaller) {
  return { tenantId: caller.context.tenantId, actorId: caller.context.actorId };
}

function readOwner(caller: AppServiceCaller) {
  return { ...exactOwner(caller), requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context) };
}

function mutationContext(caller: AppServiceCaller) {
  if (!caller.executionScope || !caller.idempotencyKey) throw new Error("Notification mutation service requires execution attribution.");
  return { executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey };
}
