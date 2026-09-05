import { createHash } from "node:crypto";
import { z } from "zod";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export const NOTIFICATION_EVENT_SCHEMA_VERSION = 1 as const;

const opaqueIdSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const notificationMutationEventPayloadSchema = z.object({
  schemaVersion: z.literal(NOTIFICATION_EVENT_SCHEMA_VERSION),
  notificationId: opaqueIdSchema,
  sourceType: z.literal("today_item"),
  sourceId: opaqueIdSchema,
  action: z.enum(["read", "dismiss", "snooze", "complete"]),
  status: z.enum(["read", "dismissed", "snoozed", "acted"]),
  idempotencyKeySha256: sha256Schema,
}).strict();

export const notificationBulkMutationEventPayloadSchema = z.object({
  schemaVersion: z.literal(NOTIFICATION_EVENT_SCHEMA_VERSION),
  action: z.literal("read_all"),
  idempotencyKeySha256: sha256Schema,
}).strict();

export type NotificationMutationContext = Readonly<{
  executionScope: ExecutionScope;
  idempotencyKey: string;
}>;

export function notificationMutationFromRequest(
  request: Request,
  context: SecurityContext,
  notificationId: string,
): NotificationMutationContext {
  const supplied = request.headers.get("idempotency-key")?.trim();
  if (
    supplied &&
    (supplied.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(supplied))
  ) {
    throw new Error(
      "Idempotency-Key must be 200 characters or fewer and use letters, numbers, dot, underscore, colon, or hyphen.",
    );
  }
  const requestId = request.headers.get("x-request-id")?.trim();
  const correlationId = requestId && requestId.length <= 240
    ? requestId
    : supplied || crypto.randomUUID();
  return {
    idempotencyKey: supplied || correlationId,
    executionScope: executionScopeFromSecurityContext(context, {
      correlationId,
      causationId: notificationId,
      purpose: "notification.update",
    }),
  };
}

export function notificationBulkMutationFromRequest(
  request: Request,
  context: SecurityContext,
): NotificationMutationContext {
  const mutation = notificationMutationFromRequest(
    request,
    context,
    "notifications:read_all",
  );
  return {
    ...mutation,
    executionScope: executionScopeFromSecurityContext(context, {
      correlationId: mutation.executionScope.correlationId,
      causationId: "notifications:read_all",
      purpose: "notification.read_all",
    }),
  };
}

export function notificationMutationEventId(input: {
  tenantId: string;
  actorId: string;
  idempotencyKey: string;
}) {
  return `notification_mutation_event_${notificationSha256(input)}`;
}

export function notificationSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
