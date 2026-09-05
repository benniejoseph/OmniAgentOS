import { createHash } from "node:crypto";
import { z } from "zod";

export const MEMORY_DATA_RIGHT_REQUEST_SCHEMA_VERSION = 1 as const;
export const MEMORY_DATA_RIGHT_REQUEST_EVENT_SCHEMA_VERSION = 1 as const;

export const MEMORY_DATA_RIGHT_REQUEST_EVENT_TYPES = Object.freeze({
  held: "memory.data_right_request.held",
  active: "memory.data_right_request.activated",
  consumed: "memory.data_right_request.consumed",
  revoked: "memory.data_right_request.revoked",
} as const);

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const actorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const requestIdSchema = opaqueIdSchema.regex(
  /^memory-data-right-request:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
);
const purposeSchema = z.enum(["memory.export.v1", "memory.forget.v1"]);
const confirmationKindSchema = z.enum([
  "explicit_export_request",
  "reviewed_deletion_preview",
]);
const stateSchema = z.enum(["held", "active", "consumed", "revoked"]);
const resourceIdsSchema = z
  .array(opaqueIdSchema)
  .min(1)
  .max(256)
  .refine(
    (values) => values.every(
      (value, index) => index === 0 || values[index - 1] < value,
    ),
    "Data-right resources must be sorted and unique.",
  );

export const memoryDataRightRequestRecordV1Schema = z
  .object({
    schemaVersion: z.literal(MEMORY_DATA_RIGHT_REQUEST_SCHEMA_VERSION),
    tenantId: opaqueIdSchema,
    requestId: requestIdSchema,
    requestGeneration: positiveIntegerSchema,
    purposeId: purposeSchema,
    subjectActorId: actorIdSchema,
    executingPrincipalType: z.literal("user"),
    executingPrincipalId: actorIdSchema,
    confirmationKind: confirmationKindSchema,
    requestBindingSha256: sha256Schema,
    resourceIds: resourceIdsSchema,
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
    state: stateSchema,
    lifecycleRevision: nonnegativeIntegerSchema,
    createdByActorId: actorIdSchema,
    activatedByActorId: actorIdSchema.nullable(),
    consumedByActorId: actorIdSchema.nullable(),
    revokedByActorId: actorIdSchema.nullable(),
    createdAt: timestampSchema,
    activatedAt: timestampSchema.nullable(),
    consumedAt: timestampSchema.nullable(),
    revokedAt: timestampSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const expectedConfirmation = request.purposeId === "memory.forget.v1"
      ? "reviewed_deletion_preview"
      : "explicit_export_request";
    if (request.confirmationKind !== expectedConfirmation) {
      context.addIssue({
        code: "custom",
        message: "Data-right confirmation does not match its purpose.",
      });
    }
    if (
      request.executingPrincipalId !== request.subjectActorId ||
      request.createdByActorId !== request.subjectActorId ||
      (request.activatedByActorId !== null &&
        request.activatedByActorId !== request.subjectActorId) ||
      (request.consumedByActorId !== null &&
        request.consumedByActorId !== request.subjectActorId) ||
      (request.revokedByActorId !== null &&
        request.revokedByActorId !== request.subjectActorId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Data-right lifecycle actors must equal the subject actor.",
      });
    }

    const lifecycleValid =
      (request.state === "held" &&
        request.lifecycleRevision === 0 &&
        request.activatedAt === null &&
        request.activatedByActorId === null &&
        request.consumedAt === null &&
        request.consumedByActorId === null &&
        request.revokedAt === null &&
        request.revokedByActorId === null) ||
      (request.state === "active" &&
        request.lifecycleRevision === 1 &&
        request.activatedAt !== null &&
        request.activatedByActorId !== null &&
        request.consumedAt === null &&
        request.consumedByActorId === null &&
        request.revokedAt === null &&
        request.revokedByActorId === null) ||
      (request.state === "consumed" &&
        request.lifecycleRevision === 2 &&
        request.activatedAt !== null &&
        request.activatedByActorId !== null &&
        request.consumedAt !== null &&
        request.consumedByActorId !== null &&
        request.revokedAt === null &&
        request.revokedByActorId === null) ||
      (request.state === "revoked" &&
        request.revokedAt !== null &&
        request.revokedByActorId !== null &&
        request.consumedAt === null &&
        request.consumedByActorId === null &&
        ((request.lifecycleRevision === 1 &&
          request.activatedAt === null &&
          request.activatedByActorId === null) ||
          (request.lifecycleRevision === 2 &&
            request.activatedAt !== null &&
            request.activatedByActorId !== null)));
    if (!lifecycleValid) {
      context.addIssue({
        code: "custom",
        message: "Data-right request lifecycle is inconsistent.",
      });
    }

    const createdAt = Date.parse(request.createdAt);
    const notBefore = Date.parse(request.notBefore);
    const expiresAt = Date.parse(request.expiresAt);
    const updatedAt = Date.parse(request.updatedAt);
    const activatedAt = request.activatedAt === null
      ? null
      : Date.parse(request.activatedAt);
    const consumedAt = request.consumedAt === null
      ? null
      : Date.parse(request.consumedAt);
    const revokedAt = request.revokedAt === null
      ? null
      : Date.parse(request.revokedAt);
    if (
      createdAt > notBefore ||
      notBefore >= expiresAt ||
      updatedAt < createdAt ||
      (activatedAt !== null &&
        (activatedAt < notBefore || activatedAt >= expiresAt || activatedAt > updatedAt)) ||
      (consumedAt !== null &&
        (activatedAt === null || consumedAt < activatedAt || consumedAt > updatedAt)) ||
      (revokedAt !== null &&
        (revokedAt < createdAt || revokedAt > updatedAt ||
          (activatedAt !== null && revokedAt < activatedAt)))
    ) {
      context.addIssue({
        code: "custom",
        message: "Data-right request timestamps are inconsistent.",
      });
    }
  });

export type MemoryDataRightRequestRecordV1 = Readonly<
  z.infer<typeof memoryDataRightRequestRecordV1Schema>
>;

export function parseMemoryDataRightRequestRecordV1(value: unknown) {
  return Object.freeze(memoryDataRightRequestRecordV1Schema.parse(value));
}

export function buildMemoryDataRightRequestEventV1(
  recordValue: unknown,
  governanceDecisionId: string,
) {
  const record = parseMemoryDataRightRequestRecordV1(recordValue);
  const [decisionActorId, decisionAt] = record.state === "held"
    ? [record.createdByActorId, record.createdAt]
    : record.state === "active"
      ? [record.activatedByActorId, record.activatedAt]
      : record.state === "consumed"
        ? [record.consumedByActorId, record.consumedAt]
        : [record.revokedByActorId, record.revokedAt];
  return Object.freeze({
    type: MEMORY_DATA_RIGHT_REQUEST_EVENT_TYPES[record.state],
    payload: Object.freeze({
      schemaVersion: MEMORY_DATA_RIGHT_REQUEST_EVENT_SCHEMA_VERSION,
      recordSchemaVersion: record.schemaVersion,
      payloadKind: "memory_data_right_request" as const,
      tenantId: record.tenantId,
      requestId: record.requestId,
      requestGeneration: record.requestGeneration,
      purposeId: record.purposeId,
      subjectActorId: record.subjectActorId,
      confirmationKind: record.confirmationKind,
      requestBindingSha256: record.requestBindingSha256,
      resourceCount: record.resourceIds.length,
      resourceSetSha256: createHash("sha256")
        .update(JSON.stringify(record.resourceIds))
        .digest("hex"),
      state: record.state,
      lifecycleRevision: record.lifecycleRevision,
      decisionActorId,
      decisionAt,
      governanceDecisionId: opaqueIdSchema.parse(governanceDecisionId),
    }),
  });
}
