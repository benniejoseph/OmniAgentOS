import { createHash } from "node:crypto";
import { z } from "zod";

const opaqueId = z.string().trim().min(1).max(240);

// `notification` was added to the frozen native cause enum in contract v23.
// Keep the minimum next to the target contract so server-side fan-out can
// preserve rolling compatibility with still-active v22 sessions.
export const GENERIC_NOTIFICATION_TARGET_MIN_NATIVE_CONTRACT_VERSION = 23;

export const mobilePushTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approval"), id: opaqueId }).strict(),
  z.object({
    kind: z.literal("work_item"),
    id: opaqueId,
    parentId: opaqueId.optional(),
  }).strict(),
  z.object({ kind: z.literal("meeting"), id: opaqueId }).strict(),
  z.object({ kind: z.literal("customer"), id: opaqueId }).strict(),
  z.object({ kind: z.literal("run"), id: opaqueId }).strict(),
  z.object({ kind: z.literal("notification"), id: opaqueId }).strict(),
  z.object({ kind: z.literal("canary"), id: opaqueId }).strict(),
]);

export type MobilePushTarget = z.infer<typeof mobilePushTargetSchema>;
export type MobilePushPreviewPolicy = "hidden" | "generic" | "title";

export const mobilePushReceiptRequestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["received", "opened", "action"]),
  action: z.enum(["open", "complete", "snooze", "dismiss"]).optional(),
  observedAt: z.string().datetime({ offset: true }),
  appLifecycle: z.enum(["foreground", "background", "terminated", "unknown"]),
}).strict().superRefine((value, refinement) => {
  if ((value.kind === "action") === (value.action !== undefined)) return;
  refinement.addIssue({
    code: "custom",
    path: ["action"],
    message: "An action is required only for an action receipt.",
  });
});

export type MobilePushReceiptInput = z.infer<
  typeof mobilePushReceiptRequestSchema
>;

export const mobilePushEnvelopeSchema = z.object({
  schemaVersion: z.literal("1"),
  deliveryId: opaqueId,
  notificationId: opaqueId.optional(),
  causeKind: z.enum([
    "approval",
    "work_item",
    "meeting",
    "customer",
    "run",
    "notification",
    "canary",
  ]),
  causeId: opaqueId,
  parentId: opaqueId.optional(),
  deepLink: z.string().min(2).max(1_000),
}).strict().superRefine((value, refinement) => {
  if (value.causeKind === "work_item" || value.parentId === undefined) return;
  refinement.addIssue({
    code: "custom",
    path: ["parentId"],
    message: "Only work-item targets may name a parent.",
  });
});

export type MobilePushEnvelope = z.infer<typeof mobilePushEnvelopeSchema>;

export function mobilePushDeepLink(input: MobilePushTarget) {
  const target = mobilePushTargetSchema.parse(input);
  const id = encodeURIComponent(target.id);
  switch (target.kind) {
    case "approval":
      return `/inbox/approvals/${id}`;
    case "work_item":
      return target.parentId
        ? `/projects/${encodeURIComponent(target.parentId)}?workItemId=${id}`
        : `/today?workItemId=${id}`;
    case "meeting":
      return `/meetings/${id}`;
    case "customer":
      return `/customers/${id}`;
    case "run":
      return `/results/${encodeURIComponent(`agent:${target.id}`)}`;
    case "notification":
      return `/inbox?notificationId=${id}`;
    case "canary":
      return `/settings?pushCanary=${id}`;
  }
}

export function createMobilePushEnvelope(input: {
  deliveryId: string;
  notificationId?: string;
  target: MobilePushTarget;
}): MobilePushEnvelope {
  return mobilePushEnvelopeSchema.parse({
    schemaVersion: "1",
    deliveryId: input.deliveryId,
    notificationId: input.notificationId,
    causeKind: input.target.kind,
    causeId: input.target.id,
    parentId: input.target.kind === "work_item"
      ? input.target.parentId
      : undefined,
    deepLink: mobilePushDeepLink(input.target),
  });
}

export function mobilePushDedupeKey(value: unknown) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function mobilePushPreview(
  policy: MobilePushPreviewPolicy,
  target: MobilePushTarget,
  sensitiveTitle?: string,
) {
  if (policy === "hidden") return undefined;
  if (policy === "title" && sensitiveTitle?.trim()) {
    return {
      title: "Asael",
      body: sensitiveTitle.replace(/\s+/g, " ").trim().slice(0, 160),
    } as const;
  }
  const subject = target.kind === "approval"
    ? "An approval needs your attention."
    : target.kind === "work_item"
      ? "A work item needs your attention."
      : target.kind === "meeting"
        ? "A meeting update is ready."
        : target.kind === "customer"
          ? "A customer update needs your attention."
          : target.kind === "run"
            ? "A run update is ready."
            : target.kind === "notification"
              ? "A notification summary needs your attention."
              : "Push notification verification is ready.";
  return { title: "Asael", body: subject } as const;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
