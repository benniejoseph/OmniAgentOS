import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

// Pure wire shapes shared by service execution and immutable native publication.
// Keep authentication and database imports in the service boundary.
export const APP_SERVICE_BOUNDARY_VERSION =
  "p9.1-app-service-boundary:1" as const;
export const APP_SERVICE_RECEIPT_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const appServiceReceiptBodySchema = z.object({
  schemaVersion: z.literal(APP_SERVICE_RECEIPT_SCHEMA_VERSION),
  receiptKind: z.literal("app_service_receipt"),
  boundaryVersion: z.literal(APP_SERVICE_BOUNDARY_VERSION),
  operation: z.string().trim().min(1).max(160),
  action: z.string().trim().min(1).max(120),
  resourceType: z.string().trim().min(1).max(120),
  accessMode: z.enum(["read", "mutation"]),
  eventContract: z.string().trim().min(1).max(160),
  authoritySha256: sha256Schema,
  idempotencyKeySha256: sha256Schema.nullable(),
  outcomeSha256: sha256Schema,
  resourceCount: z.number().int().min(0).max(1_000_000),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export const appServiceReceiptSchema = appServiceReceiptBodySchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, refinement) => {
  const { receiptSha256, ...body } = value;
  if (receiptSha256 !== canonicalJsonSha256(body)) {
    refinement.addIssue({
      code: "custom",
      path: ["receiptSha256"],
      message: "Application-service receipt digest does not match its body.",
    });
  }
});

export type AppServiceReceipt = z.infer<typeof appServiceReceiptSchema>;
