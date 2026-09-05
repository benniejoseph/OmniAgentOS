import { z } from "zod";

export const MEMORY_GRANT_RECORD_SCHEMA_VERSION = 1 as const;
export const MEMORY_GRANT_EVENT_SCHEMA_VERSION = 1 as const;

export const MEMORY_GRANT_EVENT_TYPES = Object.freeze({
  held: "memory.access_grant.held",
  active: "memory.access_grant.activated",
  revoked: "memory.access_grant.revoked",
} as const);

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const actorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const agentIdSchema = opaqueIdSchema.regex(/^agent:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const systemIdSchema = opaqueIdSchema.regex(/^service:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const workspaceIdSchema = opaqueIdSchema.regex(/^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);
const canonicalIdSetSchema = z
  .array(opaqueIdSchema)
  .min(1)
  .max(128)
  .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1] < id), {
    message: "Expected a sorted, unique canonical ID set.",
  });

export const memoryGrantKindSchema = z.enum(["context", "capability"]);
export const memoryGrantStateSchema = z.enum(["held", "active", "revoked"]);
export const memoryGrantVisibilitySchema = z.enum([
  "agent_private",
  "user_private",
  "mission_shared",
  "project_shared",
  "workspace_shared",
]);
export const memoryGrantPurposeIdSchema = z.enum([
  "memory.read.v1",
  "memory.retrieve.v1",
  "memory.write.v1",
  "memory.correct.v1",
  "memory.forget.v1",
  "memory.formation.v1",
  "memory.maintenance.v1",
  "memory.export.v1",
]);

const grantTargetSchema = z
  .object({
    visibility: memoryGrantVisibilitySchema,
    ownerActorId: actorIdSchema,
    ownerAgentId: agentIdSchema.nullable(),
    ownerAgentPrincipalGeneration: positiveSafeIntegerSchema.nullable(),
    workspaceId: workspaceIdSchema.nullable(),
    projectId: opaqueIdSchema.nullable(),
    missionId: opaqueIdSchema.nullable(),
    resourceIds: canonicalIdSetSchema,
  })
  .strict()
  .superRefine((target, context) => {
    const valid =
      (target.visibility === "agent_private" &&
        target.ownerAgentId !== null &&
        target.ownerAgentPrincipalGeneration !== null &&
        target.workspaceId === null &&
        target.projectId === null &&
        target.missionId === null) ||
      (target.visibility === "user_private" &&
        target.ownerAgentId === null &&
        target.ownerAgentPrincipalGeneration === null &&
        target.workspaceId === null &&
        target.projectId === null &&
        target.missionId === null) ||
      (target.visibility === "mission_shared" &&
        target.ownerAgentId === null &&
        target.ownerAgentPrincipalGeneration === null &&
        target.workspaceId === null &&
        target.projectId === null &&
        target.missionId !== null) ||
      (target.visibility === "project_shared" &&
        target.ownerAgentId === null &&
        target.ownerAgentPrincipalGeneration === null &&
        target.workspaceId !== null &&
        target.projectId !== null &&
        target.missionId === null) ||
      (target.visibility === "workspace_shared" &&
        target.ownerAgentId === null &&
        target.ownerAgentPrincipalGeneration === null &&
        target.workspaceId !== null &&
        target.projectId === null &&
        target.missionId === null);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "Memory grant target coordinates do not match visibility.",
      });
    }
  });

const grantLifecycle = {
  state: memoryGrantStateSchema,
  lifecycleRevision: nonnegativeSafeIntegerSchema,
  createdByActorId: actorIdSchema,
  activatedByActorId: actorIdSchema.nullable(),
  revokedByActorId: actorIdSchema.nullable(),
  createdAt: canonicalTimestampSchema,
  activatedAt: canonicalTimestampSchema.nullable(),
  revokedAt: canonicalTimestampSchema.nullable(),
  updatedAt: canonicalTimestampSchema,
};

const commonGrantFields = {
  schemaVersion: z.literal(MEMORY_GRANT_RECORD_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  grantGeneration: positiveSafeIntegerSchema,
  purposeId: memoryGrantPurposeIdSchema,
  target: grantTargetSchema,
  notBefore: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
  ...grantLifecycle,
};

function grantVariant<
  Kind extends "context" | "capability",
  PrincipalKind extends "user" | "agent" | "system",
>(
  grantKind: Kind,
  principalKind: PrincipalKind,
) {
  const principalFields = principalKind === "user"
    ? {
        granteeKind: z.literal("user"),
        granteeId: actorIdSchema,
        granteePrincipalGeneration: z.null(),
      }
    : principalKind === "agent"
      ? {
          granteeKind: z.literal("agent"),
          granteeId: agentIdSchema,
          granteePrincipalGeneration: positiveSafeIntegerSchema,
        }
      : {
          granteeKind: z.literal("system"),
          granteeId: systemIdSchema,
          granteePrincipalGeneration: positiveSafeIntegerSchema,
        };
  const kindFields = grantKind === "context"
    ? {
        grantKind: z.literal("context"),
        grantId: opaqueIdSchema.regex(/^context:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/),
        operationIds: z.null(),
        maxItems: positiveSafeIntegerSchema,
        maxBytes: positiveSafeIntegerSchema,
        maxInvocations: z.null(),
        maxCostMicrousd: z.null(),
        maxDurationMs: z.null(),
      }
    : {
        grantKind: z.literal("capability"),
        grantId: opaqueIdSchema.regex(/^capability:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/),
        operationIds: canonicalIdSetSchema,
        maxItems: z.null(),
        maxBytes: z.null(),
        maxInvocations: positiveSafeIntegerSchema,
        maxCostMicrousd: positiveSafeIntegerSchema,
        maxDurationMs: positiveSafeIntegerSchema,
      };
  return z.object({ ...commonGrantFields, ...kindFields, ...principalFields }).strict();
}

export const memoryAccessGrantRecordV1Schema = z
  .discriminatedUnion("grantKind", [
    z.discriminatedUnion("granteeKind", [
      grantVariant("context", "user"),
      grantVariant("context", "agent"),
      grantVariant("context", "system"),
    ]),
    z.discriminatedUnion("granteeKind", [
      grantVariant("capability", "user"),
      grantVariant("capability", "agent"),
      grantVariant("capability", "system"),
    ]),
  ])
  .superRefine((grant, context) => {
    const validLifecycle =
      (grant.state === "held" &&
        grant.lifecycleRevision === 0 &&
        grant.activatedByActorId === null &&
        grant.activatedAt === null &&
        grant.revokedByActorId === null &&
        grant.revokedAt === null) ||
      (grant.state === "active" &&
        grant.lifecycleRevision === 1 &&
        grant.activatedByActorId !== null &&
        grant.activatedAt !== null &&
        grant.revokedByActorId === null &&
        grant.revokedAt === null) ||
      (grant.state === "revoked" &&
        grant.revokedByActorId !== null &&
        grant.revokedAt !== null &&
        ((grant.lifecycleRevision === 1 &&
          grant.activatedByActorId === null &&
          grant.activatedAt === null) ||
          (grant.lifecycleRevision === 2 &&
            grant.activatedByActorId !== null &&
            grant.activatedAt !== null)));
    if (!validLifecycle) {
      context.addIssue({ code: "custom", message: "Memory grant lifecycle is inconsistent." });
    }
    const createdAt = Date.parse(grant.createdAt);
    const notBefore = Date.parse(grant.notBefore);
    const expiresAt = Date.parse(grant.expiresAt);
    const updatedAt = Date.parse(grant.updatedAt);
    const activatedAt = grant.activatedAt === null ? null : Date.parse(grant.activatedAt);
    const revokedAt = grant.revokedAt === null ? null : Date.parse(grant.revokedAt);
    if (
      notBefore < createdAt ||
      expiresAt <= notBefore ||
      updatedAt < createdAt ||
      (activatedAt !== null && (activatedAt < createdAt || activatedAt > updatedAt)) ||
      (revokedAt !== null && (revokedAt < createdAt || revokedAt > updatedAt)) ||
      (activatedAt !== null && revokedAt !== null && revokedAt < activatedAt)
    ) {
      context.addIssue({ code: "custom", message: "Memory grant timestamps are inconsistent." });
    }
  });

export type MemoryAccessGrantRecordV1 = Readonly<z.infer<typeof memoryAccessGrantRecordV1Schema>>;

export function parseMemoryAccessGrantRecordV1(value: unknown) {
  return Object.freeze(memoryAccessGrantRecordV1Schema.parse(value));
}

export function buildMemoryAccessGrantEventV1(
  recordValue: unknown,
  governanceDecisionId: string,
) {
  const record = parseMemoryAccessGrantRecordV1(recordValue);
  const [decisionActorId, decisionAt] = record.state === "held"
    ? [record.createdByActorId, record.createdAt]
    : record.state === "active"
      ? [record.activatedByActorId, record.activatedAt]
      : [record.revokedByActorId, record.revokedAt];
  return Object.freeze({
    type: MEMORY_GRANT_EVENT_TYPES[record.state],
    payload: Object.freeze({
      schemaVersion: MEMORY_GRANT_EVENT_SCHEMA_VERSION,
      recordSchemaVersion: record.schemaVersion,
      payloadKind: "memory_access_grant" as const,
      tenantId: record.tenantId,
      grantKind: record.grantKind,
      grantId: record.grantId,
      grantGeneration: record.grantGeneration,
      granteeKind: record.granteeKind,
      granteeId: record.granteeId,
      granteePrincipalGeneration: record.granteePrincipalGeneration,
      purposeId: record.purposeId,
      targetVisibility: record.target.visibility,
      resourceIds: Object.freeze([...record.target.resourceIds]),
      state: record.state,
      lifecycleRevision: record.lifecycleRevision,
      decisionActorId,
      decisionAt,
      governanceDecisionId: opaqueIdSchema.parse(governanceDecisionId),
    }),
  });
}
