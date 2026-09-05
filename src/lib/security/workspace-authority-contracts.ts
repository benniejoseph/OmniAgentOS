import { z } from "zod";

export const WORKSPACE_AUTHORITY_RECORD_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_AUTHORITY_EVENT_SCHEMA_VERSION = 1 as const;

export const WORKSPACE_AUTHORITY_EVENT_TYPES = Object.freeze({
  held: "security.workspace.held",
  active: "security.workspace.activated",
  archived: "security.workspace.archived",
} as const);

export const WORKSPACE_MEMBERSHIP_EVENT_TYPES = Object.freeze({
  held: "security.workspace_membership.held",
  active: "security.workspace_membership.activated",
  revoked: "security.workspace_membership.revoked",
} as const);

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const canonicalActorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const workspaceIdSchema = opaqueIdSchema.regex(
  /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const agentPrincipalIdSchema = opaqueIdSchema.regex(
  /^agent:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const systemPrincipalIdSchema = opaqueIdSchema.regex(
  /^service:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);

export const workspaceStateSchema = z.enum(["held", "active", "archived"]);
export const workspaceMembershipStateSchema = z.enum(["held", "active", "revoked"]);
export const workspaceMembershipSubjectKindSchema = z.enum([
  "user",
  "agent",
  "system",
]);
export const workspaceMembershipAccessLevelSchema = z.enum([
  "reader",
  "contributor",
  "manager",
]);

export const workspaceAuthorityRecordV1Schema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_AUTHORITY_RECORD_SCHEMA_VERSION),
    tenantId: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    state: workspaceStateSchema,
    lifecycleRevision: nonnegativeSafeIntegerSchema,
    createdByActorId: canonicalActorIdSchema,
    activatedByActorId: canonicalActorIdSchema.nullable(),
    archivedByActorId: canonicalActorIdSchema.nullable(),
    createdAt: canonicalTimestampSchema,
    activatedAt: canonicalTimestampSchema.nullable(),
    archivedAt: canonicalTimestampSchema.nullable(),
    updatedAt: canonicalTimestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const valid =
      (record.state === "held" &&
        record.lifecycleRevision === 0 &&
        record.activatedByActorId === null &&
        record.activatedAt === null &&
        record.archivedByActorId === null &&
        record.archivedAt === null) ||
      (record.state === "active" &&
        record.lifecycleRevision === 1 &&
        record.activatedByActorId !== null &&
        record.activatedAt !== null &&
        record.archivedByActorId === null &&
        record.archivedAt === null) ||
      (record.state === "archived" &&
        record.archivedByActorId !== null &&
        record.archivedAt !== null &&
        ((record.lifecycleRevision === 1 &&
          record.activatedByActorId === null &&
          record.activatedAt === null) ||
          (record.lifecycleRevision === 2 &&
            record.activatedByActorId !== null &&
            record.activatedAt !== null)));
    if (!valid) {
      context.addIssue({ code: "custom", message: "Workspace lifecycle is inconsistent." });
    }
    addChronologyIssue(record, context, record.archivedAt);
  });

const membershipBase = z.object({
  schemaVersion: z.literal(WORKSPACE_AUTHORITY_RECORD_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  membershipGeneration: positiveSafeIntegerSchema,
  accessLevel: workspaceMembershipAccessLevelSchema,
  state: workspaceMembershipStateSchema,
  lifecycleRevision: nonnegativeSafeIntegerSchema,
  createdByActorId: canonicalActorIdSchema,
  activatedByActorId: canonicalActorIdSchema.nullable(),
  revokedByActorId: canonicalActorIdSchema.nullable(),
  createdAt: canonicalTimestampSchema,
  activatedAt: canonicalTimestampSchema.nullable(),
  revokedAt: canonicalTimestampSchema.nullable(),
  updatedAt: canonicalTimestampSchema,
});

export const workspaceMembershipRecordV1Schema = z
  .discriminatedUnion("subjectKind", [
    membershipBase.extend({
      subjectKind: z.literal("user"),
      subjectKey: canonicalActorIdSchema,
      subjectActorId: canonicalActorIdSchema,
      subjectExecutionPrincipalId: z.null(),
      subjectExecutionPrincipalGeneration: z.null(),
    }).strict(),
    membershipBase.extend({
      subjectKind: z.literal("agent"),
      subjectKey: agentPrincipalIdSchema,
      subjectActorId: z.null(),
      subjectExecutionPrincipalId: agentPrincipalIdSchema,
      subjectExecutionPrincipalGeneration: positiveSafeIntegerSchema,
    }).strict(),
    membershipBase.extend({
      subjectKind: z.literal("system"),
      subjectKey: systemPrincipalIdSchema,
      subjectActorId: z.null(),
      subjectExecutionPrincipalId: systemPrincipalIdSchema,
      subjectExecutionPrincipalGeneration: positiveSafeIntegerSchema,
    }).strict(),
  ])
  .superRefine((record, context) => {
    if (
      (record.subjectKind === "user" && record.subjectKey !== record.subjectActorId) ||
      (record.subjectKind !== "user" &&
        record.subjectKey !== record.subjectExecutionPrincipalId)
    ) {
      context.addIssue({ code: "custom", message: "Workspace membership subject is inconsistent." });
    }
    const valid =
      (record.state === "held" &&
        record.lifecycleRevision === 0 &&
        record.activatedByActorId === null &&
        record.activatedAt === null &&
        record.revokedByActorId === null &&
        record.revokedAt === null) ||
      (record.state === "active" &&
        record.lifecycleRevision === 1 &&
        record.activatedByActorId !== null &&
        record.activatedAt !== null &&
        record.revokedByActorId === null &&
        record.revokedAt === null) ||
      (record.state === "revoked" &&
        record.revokedByActorId !== null &&
        record.revokedAt !== null &&
        ((record.lifecycleRevision === 1 &&
          record.activatedByActorId === null &&
          record.activatedAt === null) ||
          (record.lifecycleRevision === 2 &&
            record.activatedByActorId !== null &&
            record.activatedAt !== null)));
    if (!valid) {
      context.addIssue({ code: "custom", message: "Workspace membership lifecycle is inconsistent." });
    }
    addChronologyIssue(record, context, record.revokedAt);
  });

export type WorkspaceAuthorityRecordV1 = Readonly<z.infer<typeof workspaceAuthorityRecordV1Schema>>;
export type WorkspaceMembershipRecordV1 = Readonly<z.infer<typeof workspaceMembershipRecordV1Schema>>;

export function parseWorkspaceAuthorityRecordV1(value: unknown) {
  return Object.freeze(workspaceAuthorityRecordV1Schema.parse(value));
}

export function parseWorkspaceMembershipRecordV1(value: unknown) {
  return Object.freeze(workspaceMembershipRecordV1Schema.parse(value));
}

export function buildWorkspaceAuthorityEventV1(
  recordValue: unknown,
  governanceDecisionId: string,
) {
  const record = parseWorkspaceAuthorityRecordV1(recordValue);
  const [decisionActorId, decisionAt] = record.state === "held"
    ? [record.createdByActorId, record.createdAt]
    : record.state === "active"
      ? [record.activatedByActorId, record.activatedAt]
      : [record.archivedByActorId, record.archivedAt];
  return Object.freeze({
    type: WORKSPACE_AUTHORITY_EVENT_TYPES[record.state],
    payload: Object.freeze({
      schemaVersion: WORKSPACE_AUTHORITY_EVENT_SCHEMA_VERSION,
      recordSchemaVersion: record.schemaVersion,
      payloadKind: "workspace" as const,
      tenantId: record.tenantId,
      workspaceId: record.workspaceId,
      state: record.state,
      lifecycleRevision: record.lifecycleRevision,
      decisionActorId,
      decisionAt,
      governanceDecisionId: opaqueIdSchema.parse(governanceDecisionId),
    }),
  });
}

export function buildWorkspaceMembershipEventV1(
  recordValue: unknown,
  governanceDecisionId: string,
) {
  const record = parseWorkspaceMembershipRecordV1(recordValue);
  const [decisionActorId, decisionAt] = record.state === "held"
    ? [record.createdByActorId, record.createdAt]
    : record.state === "active"
      ? [record.activatedByActorId, record.activatedAt]
      : [record.revokedByActorId, record.revokedAt];
  return Object.freeze({
    type: WORKSPACE_MEMBERSHIP_EVENT_TYPES[record.state],
    payload: Object.freeze({
      schemaVersion: WORKSPACE_AUTHORITY_EVENT_SCHEMA_VERSION,
      recordSchemaVersion: record.schemaVersion,
      payloadKind: "workspace_membership" as const,
      tenantId: record.tenantId,
      workspaceId: record.workspaceId,
      subjectKind: record.subjectKind,
      subjectKey: record.subjectKey,
      subjectExecutionPrincipalGeneration: record.subjectExecutionPrincipalGeneration,
      membershipGeneration: record.membershipGeneration,
      accessLevel: record.accessLevel,
      state: record.state,
      lifecycleRevision: record.lifecycleRevision,
      decisionActorId,
      decisionAt,
      governanceDecisionId: opaqueIdSchema.parse(governanceDecisionId),
    }),
  });
}

function addChronologyIssue(
  record: {
    createdAt: string;
    activatedAt: string | null;
    updatedAt: string;
  },
  context: z.RefinementCtx,
  terminalAt: string | null,
) {
  const createdAt = Date.parse(record.createdAt);
  const activatedAt = record.activatedAt === null ? null : Date.parse(record.activatedAt);
  const updatedAt = Date.parse(record.updatedAt);
  const terminal = terminalAt === null ? null : Date.parse(terminalAt);
  if (
    updatedAt < createdAt ||
    (activatedAt !== null && (activatedAt < createdAt || activatedAt > updatedAt)) ||
    (terminal !== null && (terminal < createdAt || terminal > updatedAt)) ||
    (activatedAt !== null && terminal !== null && terminal < activatedAt)
  ) {
    context.addIssue({ code: "custom", message: "Workspace authority timestamps are inconsistent." });
  }
}
