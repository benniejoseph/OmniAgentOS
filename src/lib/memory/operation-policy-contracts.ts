import { z } from "zod";

export const MEMORY_OPERATION_POLICY_SCHEMA_VERSION = 1 as const;
export const MEMORY_OPERATION_POLICY_EVENT_SCHEMA_VERSION = 1 as const;

export const MEMORY_OPERATION_POLICY_EVENT_TYPES = Object.freeze({
  held: "memory.operation_policy.held",
  active: "memory.operation_policy.activated",
  revoked: "memory.operation_policy.revoked",
} as const);

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const actorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const memoryOperationClassSchema = z.enum([
  "read",
  "retrieve",
  "write",
  "correct",
  "forget",
  "formation",
  "maintenance",
  "export",
]);
export const memoryOperationRiskClassSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
export const memoryOperationPolicyStateSchema = z.enum(["held", "active", "revoked"]);
const principalKindSchema = z.enum(["agent", "system", "user"]);
const visibilitySchema = z.enum([
  "agent_private",
  "mission_shared",
  "project_shared",
  "user_private",
  "workspace_shared",
]);
const sensitivitySchema = z.enum([
  "confidential",
  "internal",
  "public",
  "restricted",
]);

function canonicalSet<T extends z.ZodTypeAny>(entry: T, maximum: number) {
  return z.array(entry).min(1).max(maximum).refine(
    (values) => values.every((value, index) => index === 0 || values[index - 1] < value),
    { message: "Expected a sorted, unique policy set." },
  );
}

export const memoryOperationPolicyRecordV1Schema = z
  .object({
    schemaVersion: z.literal(MEMORY_OPERATION_POLICY_SCHEMA_VERSION),
    tenantId: opaqueIdSchema,
    policyId: opaqueIdSchema.regex(
      /^memory-policy:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
    ),
    policyGeneration: positiveIntegerSchema,
    purposeId: opaqueIdSchema,
    operationClass: memoryOperationClassSchema,
    riskClass: memoryOperationRiskClassSchema,
    allowedPrincipalKinds: canonicalSet(principalKindSchema, 3),
    allowedVisibilities: canonicalSet(visibilitySchema, 5),
    allowedSensitivities: canonicalSet(sensitivitySchema, 4),
    requiresContextGrant: z.boolean(),
    requiresCapabilityGrant: z.literal(true),
    requiresRequestBinding: z.boolean(),
    requiresHumanApproval: z.boolean(),
    state: memoryOperationPolicyStateSchema,
    lifecycleRevision: nonnegativeIntegerSchema,
    createdByActorId: actorIdSchema,
    activatedByActorId: actorIdSchema.nullable(),
    revokedByActorId: actorIdSchema.nullable(),
    createdAt: timestampSchema,
    activatedAt: timestampSchema.nullable(),
    revokedAt: timestampSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((policy, context) => {
    const purposeId = `memory.${policy.operationClass}.v1`;
    if (policy.purposeId !== purposeId) {
      context.addIssue({ code: "custom", message: "Operation policy purpose is inconsistent." });
    }
    const expectedRisk = riskForOperation(policy.operationClass);
    if (policy.riskClass !== expectedRisk) {
      context.addIssue({ code: "custom", message: "Operation policy risk is under- or over-classified." });
    }
    const expectsContext = ["read", "retrieve", "formation"].includes(policy.operationClass);
    if (policy.requiresContextGrant !== expectsContext) {
      context.addIssue({ code: "custom", message: "Operation policy context requirement is inconsistent." });
    }
    const isDataRight = ["forget", "export"].includes(policy.operationClass);
    if (
      policy.requiresRequestBinding !== isDataRight ||
      policy.requiresHumanApproval !== isDataRight
    ) {
      context.addIssue({ code: "custom", message: "Operation policy request or approval gate is inconsistent." });
    }
    const lifecycleValid =
      (policy.state === "held" &&
        policy.lifecycleRevision === 0 &&
        policy.activatedByActorId === null &&
        policy.activatedAt === null &&
        policy.revokedByActorId === null &&
        policy.revokedAt === null) ||
      (policy.state === "active" &&
        policy.lifecycleRevision === 1 &&
        policy.activatedByActorId !== null &&
        policy.activatedAt !== null &&
        policy.revokedByActorId === null &&
        policy.revokedAt === null) ||
      (policy.state === "revoked" &&
        policy.revokedByActorId !== null &&
        policy.revokedAt !== null &&
        ((policy.lifecycleRevision === 1 &&
          policy.activatedByActorId === null &&
          policy.activatedAt === null) ||
          (policy.lifecycleRevision === 2 &&
            policy.activatedByActorId !== null &&
            policy.activatedAt !== null)));
    if (!lifecycleValid) {
      context.addIssue({ code: "custom", message: "Operation policy lifecycle is inconsistent." });
    }
    const createdAt = Date.parse(policy.createdAt);
    const updatedAt = Date.parse(policy.updatedAt);
    const activatedAt = policy.activatedAt === null ? null : Date.parse(policy.activatedAt);
    const revokedAt = policy.revokedAt === null ? null : Date.parse(policy.revokedAt);
    if (
      updatedAt < createdAt ||
      (activatedAt !== null && (activatedAt < createdAt || activatedAt > updatedAt)) ||
      (revokedAt !== null && (revokedAt < createdAt || revokedAt > updatedAt)) ||
      (activatedAt !== null && revokedAt !== null && revokedAt < activatedAt)
    ) {
      context.addIssue({ code: "custom", message: "Operation policy timestamps are inconsistent." });
    }
  });

export type MemoryOperationPolicyRecordV1 = Readonly<
  z.infer<typeof memoryOperationPolicyRecordV1Schema>
>;

export function parseMemoryOperationPolicyRecordV1(value: unknown) {
  return Object.freeze(memoryOperationPolicyRecordV1Schema.parse(value));
}

export function buildMemoryOperationPolicyEventV1(
  recordValue: unknown,
  governanceDecisionId: string,
) {
  const record = parseMemoryOperationPolicyRecordV1(recordValue);
  const [decisionActorId, decisionAt] = record.state === "held"
    ? [record.createdByActorId, record.createdAt]
    : record.state === "active"
      ? [record.activatedByActorId, record.activatedAt]
      : [record.revokedByActorId, record.revokedAt];
  return Object.freeze({
    type: MEMORY_OPERATION_POLICY_EVENT_TYPES[record.state],
    payload: Object.freeze({
      schemaVersion: MEMORY_OPERATION_POLICY_EVENT_SCHEMA_VERSION,
      recordSchemaVersion: record.schemaVersion,
      payloadKind: "memory_operation_policy" as const,
      tenantId: record.tenantId,
      policyId: record.policyId,
      policyGeneration: record.policyGeneration,
      purposeId: record.purposeId,
      operationClass: record.operationClass,
      riskClass: record.riskClass,
      state: record.state,
      lifecycleRevision: record.lifecycleRevision,
      decisionActorId,
      decisionAt,
      governanceDecisionId: opaqueIdSchema.parse(governanceDecisionId),
    }),
  });
}

function riskForOperation(operation: z.infer<typeof memoryOperationClassSchema>) {
  if (operation === "read" || operation === "retrieve") return "low";
  if (operation === "write" || operation === "formation") return "medium";
  if (operation === "forget" || operation === "export") return "critical";
  return "high";
}
