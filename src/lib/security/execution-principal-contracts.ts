import { z } from "zod";

export const EXECUTION_PRINCIPAL_RECORD_SCHEMA_VERSION = 1 as const;
export const EXECUTION_PRINCIPAL_EVENT_PAYLOAD_SCHEMA_VERSION = 1 as const;

export const EXECUTION_PRINCIPAL_EVENT_TYPES = Object.freeze({
  held: "security.execution_principal.held",
  active: "security.execution_principal.activated",
  revoked: "security.execution_principal.revoked",
} as const);

export const executionPrincipalKindSchema = z.enum(["agent", "system"]);
export const systemExecutionPrincipalClassSchema = z.enum([
  "worker",
  "scheduler",
  "workflow",
  "connector",
  "internal_service",
]);
export const executionPrincipalStateSchema = z.enum([
  "held",
  "active",
  "revoked",
]);

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
    "Expected an exact opaque ID without normalization.",
  );
const canonicalActorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "Expected a canonical auth-user actor ID.",
);
const agentPrincipalIdSchema = opaqueIdSchema.regex(
  /^agent:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
  "Expected a canonical agent principal ID.",
);
const systemPrincipalIdSchema = opaqueIdSchema.regex(
  /^service:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
  "Expected a canonical actor-bound system principal ID.",
);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => new Date(value).toISOString() === value,
    "Expected a canonical UTC timestamp with millisecond precision.",
  );

const lifecycleShape = {
  state: executionPrincipalStateSchema,
  lifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  createdByActorId: canonicalActorIdSchema,
  activatedByActorId: canonicalActorIdSchema.nullable(),
  revokedByActorId: canonicalActorIdSchema.nullable(),
  createdAt: canonicalTimestampSchema,
  activatedAt: canonicalTimestampSchema.nullable(),
  revokedAt: canonicalTimestampSchema.nullable(),
  updatedAt: canonicalTimestampSchema,
};

const agentExecutionPrincipalRecordSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_PRINCIPAL_RECORD_SCHEMA_VERSION),
    tenantId: opaqueIdSchema,
    principalKind: z.literal("agent"),
    principalId: agentPrincipalIdSchema,
    principalGeneration: positiveSafeIntegerSchema,
    controllerActorId: canonicalActorIdSchema,
    agentDefinitionId: opaqueIdSchema,
    systemPrincipalClass: z.null(),
    ...lifecycleShape,
  })
  .strict();

const systemExecutionPrincipalRecordSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_PRINCIPAL_RECORD_SCHEMA_VERSION),
    tenantId: opaqueIdSchema,
    principalKind: z.literal("system"),
    principalId: systemPrincipalIdSchema,
    principalGeneration: positiveSafeIntegerSchema,
    controllerActorId: canonicalActorIdSchema,
    agentDefinitionId: z.null(),
    systemPrincipalClass: systemExecutionPrincipalClassSchema,
    ...lifecycleShape,
  })
  .strict();

/**
 * Agent definitions remain descriptive configuration. A principal record is
 * a separate, actor-controlled security identity and never inherits tools,
 * memory, or authority from the referenced definition.
 */
export const executionPrincipalRecordV1Schema = z
  .discriminatedUnion("principalKind", [
    agentExecutionPrincipalRecordSchema,
    systemExecutionPrincipalRecordSchema,
  ])
  .superRefine(requireValidLifecycle);

export type ExecutionPrincipalRecordV1 = Readonly<
  z.infer<typeof executionPrincipalRecordV1Schema>
>;

const eventPayloadSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_PRINCIPAL_EVENT_PAYLOAD_SCHEMA_VERSION),
    recordSchemaVersion: z.literal(EXECUTION_PRINCIPAL_RECORD_SCHEMA_VERSION),
    payloadKind: z.literal("execution_principal"),
    tenantId: opaqueIdSchema,
    principalKind: executionPrincipalKindSchema,
    principalId: opaqueIdSchema,
    principalGeneration: positiveSafeIntegerSchema,
    controllerActorId: canonicalActorIdSchema,
    agentDefinitionId: opaqueIdSchema.nullable(),
    systemPrincipalClass: systemExecutionPrincipalClassSchema.nullable(),
    state: executionPrincipalStateSchema,
    lifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    decisionActorId: canonicalActorIdSchema,
    decisionAt: canonicalTimestampSchema,
    governanceDecisionId: opaqueIdSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      (payload.principalKind === "agent" &&
        (!payload.principalId.startsWith("agent:") ||
          payload.agentDefinitionId === null ||
          payload.systemPrincipalClass !== null)) ||
      (payload.principalKind === "system" &&
        (!payload.principalId.startsWith("service:") ||
          payload.agentDefinitionId !== null ||
          payload.systemPrincipalClass === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Execution-principal event identity is inconsistent.",
      });
    }
    if (
      (payload.state === "held" && payload.lifecycleRevision !== 0) ||
      (payload.state === "active" && payload.lifecycleRevision !== 1) ||
      (payload.state === "revoked" && ![1, 2].includes(payload.lifecycleRevision))
    ) {
      context.addIssue({
        code: "custom",
        message: "Execution-principal event lifecycle is inconsistent.",
        path: ["lifecycleRevision"],
      });
    }
  });

export type ExecutionPrincipalEventPayloadV1 = Readonly<
  z.infer<typeof eventPayloadSchema>
>;
export type ExecutionPrincipalEventV1 = Readonly<{
  type: (typeof EXECUTION_PRINCIPAL_EVENT_TYPES)[keyof typeof EXECUTION_PRINCIPAL_EVENT_TYPES];
  payload: ExecutionPrincipalEventPayloadV1;
}>;

export function parseExecutionPrincipalRecordV1(
  value: unknown,
): ExecutionPrincipalRecordV1 {
  return Object.freeze(executionPrincipalRecordV1Schema.parse(value));
}

export function buildExecutionPrincipalEventV1(
  input: Omit<
    ExecutionPrincipalEventPayloadV1,
    "schemaVersion" | "recordSchemaVersion" | "payloadKind"
  >,
): ExecutionPrincipalEventV1 {
  const payload = Object.freeze(eventPayloadSchema.parse({
    ...input,
    schemaVersion: EXECUTION_PRINCIPAL_EVENT_PAYLOAD_SCHEMA_VERSION,
    recordSchemaVersion: EXECUTION_PRINCIPAL_RECORD_SCHEMA_VERSION,
    payloadKind: "execution_principal",
  }));
  return Object.freeze({
    type: EXECUTION_PRINCIPAL_EVENT_TYPES[payload.state],
    payload,
  });
}

export function assertExecutionPrincipalRecordEventBindingV1(
  recordValue: unknown,
  eventValue: unknown,
) {
  const record = parseExecutionPrincipalRecordV1(recordValue);
  const event = z
    .object({ type: z.string(), payload: eventPayloadSchema })
    .strict()
    .parse(eventValue);
  const expectedType = EXECUTION_PRINCIPAL_EVENT_TYPES[record.state];
  if (event.type !== expectedType) {
    throw new Error("Execution-principal event type does not match its record.");
  }
  for (const field of [
    "tenantId",
    "principalKind",
    "principalId",
    "principalGeneration",
    "controllerActorId",
    "agentDefinitionId",
    "systemPrincipalClass",
    "state",
    "lifecycleRevision",
  ] as const) {
    if (record[field] !== event.payload[field]) {
      throw new Error(`Execution-principal event binding mismatch at ${field}.`);
    }
  }
  const [decisionActorId, decisionAt] = lifecycleDecision(record);
  if (
    event.payload.decisionActorId !== decisionActorId ||
    event.payload.decisionAt !== decisionAt
  ) {
    throw new Error("Execution-principal event decision attribution is invalid.");
  }
  return Object.freeze({ record, event: Object.freeze(event) });
}

function requireValidLifecycle(
  record: {
    state: "held" | "active" | "revoked";
    lifecycleRevision: number;
    createdAt: string;
    activatedAt: string | null;
    revokedAt: string | null;
    updatedAt: string;
    activatedByActorId: string | null;
    revokedByActorId: string | null;
  },
  context: z.RefinementCtx,
) {
  const validShape =
    (record.state === "held" &&
      record.lifecycleRevision === 0 &&
      record.activatedAt === null &&
      record.activatedByActorId === null &&
      record.revokedAt === null &&
      record.revokedByActorId === null) ||
    (record.state === "active" &&
      record.lifecycleRevision === 1 &&
      record.activatedAt !== null &&
      record.activatedByActorId !== null &&
      record.revokedAt === null &&
      record.revokedByActorId === null) ||
    (record.state === "revoked" &&
      record.revokedAt !== null &&
      record.revokedByActorId !== null &&
      ((record.lifecycleRevision === 1 &&
        record.activatedAt === null &&
        record.activatedByActorId === null) ||
        (record.lifecycleRevision === 2 &&
          record.activatedAt !== null &&
          record.activatedByActorId !== null)));
  if (!validShape) {
    context.addIssue({
      code: "custom",
      message: "Execution-principal lifecycle fields are inconsistent.",
      path: ["state"],
    });
  }

  const createdAt = Date.parse(record.createdAt);
  const updatedAt = Date.parse(record.updatedAt);
  const activatedAt = record.activatedAt === null
    ? null
    : Date.parse(record.activatedAt);
  const revokedAt = record.revokedAt === null ? null : Date.parse(record.revokedAt);
  if (
    updatedAt < createdAt ||
    (activatedAt !== null && (activatedAt < createdAt || activatedAt > updatedAt)) ||
    (revokedAt !== null && (revokedAt < createdAt || revokedAt > updatedAt)) ||
    (activatedAt !== null && revokedAt !== null && revokedAt < activatedAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "Execution-principal lifecycle timestamps are inconsistent.",
      path: ["updatedAt"],
    });
  }
}

function lifecycleDecision(record: ExecutionPrincipalRecordV1) {
  if (record.state === "held") {
    return [record.createdByActorId, record.createdAt] as const;
  }
  if (record.state === "active") {
    return [record.activatedByActorId, record.activatedAt] as const;
  }
  return [record.revokedByActorId, record.revokedAt] as const;
}
