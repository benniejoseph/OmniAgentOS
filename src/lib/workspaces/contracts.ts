import { z } from "zod";
import { CANONICAL_STATUSES } from "@/lib/status/canonical";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const CANONICAL_WORK_MODEL_SCHEMA_VERSION = 1 as const;
export const CANONICAL_WORK_EVENT_SCHEMA_VERSION = 1 as const;

const opaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const workspaceIdSchema = opaqueIdSchema.regex(
  /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const canonicalActorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const agentPrincipalIdSchema = opaqueIdSchema.regex(
  /^agent:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);
const positiveRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const uniqueIdsSchema = z.array(opaqueIdSchema).max(128).refine(isSortedUnique, {
  message: "Identifiers must be sorted and unique.",
});
const uniqueActorIdsSchema = z.array(canonicalActorIdSchema).min(1).max(32)
  .refine(isSortedUnique, { message: "Owners must be sorted and unique." });

export const canonicalWorkspaceV1Schema = z.object({
  schemaVersion: z.literal(CANONICAL_WORK_MODEL_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  displayName: z.string().trim().min(1).max(120),
  state: z.enum(["active", "archived"]),
  ownerActorId: canonicalActorIdSchema,
  lifecycleRevision: positiveRevisionSchema,
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema,
  archivedAt: canonicalTimestampSchema.nullable(),
}).strict().superRefine((workspace, context) => {
  if ((workspace.state === "archived") !== (workspace.archivedAt !== null)) {
    context.addIssue({ code: "custom", message: "Workspace lifecycle is inconsistent." });
  }
  addChronologyIssue(workspace.createdAt, workspace.updatedAt, workspace.archivedAt, context);
});

export const canonicalProjectV1Schema = z.object({
  schemaVersion: z.literal(CANONICAL_WORK_MODEL_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  projectId: opaqueIdSchema,
  ownerActorId: canonicalActorIdSchema,
  lifecycleStatus: z.enum(["draft", "active", "completed", "archived"]),
  sourceAuthority: z.literal("legacy_project"),
  lifecycleRevision: positiveRevisionSchema,
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema,
  completedAt: canonicalTimestampSchema.nullable(),
}).strict().superRefine((project, context) => {
  if ((project.lifecycleStatus === "completed") !== (project.completedAt !== null)) {
    context.addIssue({ code: "custom", message: "Project completion is inconsistent." });
  }
  addChronologyIssue(project.createdAt, project.updatedAt, project.completedAt, context);
});

const assignedAgentSchema = z.object({
  agentId: opaqueIdSchema,
  principalId: agentPrincipalIdSchema.nullable(),
  principalGeneration: positiveRevisionSchema.nullable(),
}).strict().superRefine((assignment, context) => {
  if ((assignment.principalId === null) !== (assignment.principalGeneration === null)) {
    context.addIssue({ code: "custom", message: "Agent principal binding is incomplete." });
  }
});

const scheduleSchema = z.object({
  startsAt: canonicalTimestampSchema.nullable(),
  dueAt: canonicalTimestampSchema.nullable(),
  timeZone: z.string().trim().min(1).max(80).nullable(),
}).strict().superRefine((schedule, context) => {
  if (
    schedule.startsAt !== null &&
    schedule.dueAt !== null &&
    Date.parse(schedule.startsAt) > Date.parse(schedule.dueAt)
  ) {
    context.addIssue({ code: "custom", message: "Schedule starts after its due time." });
  }
});

const recurrenceSchema = z.object({
  rrule: z.string().trim().min(1).max(2_000),
  startsAt: canonicalTimestampSchema,
  endsAt: canonicalTimestampSchema.nullable(),
  maxOccurrences: z.number().int().min(1).max(10_000).nullable(),
}).strict().superRefine((recurrence, context) => {
  if (
    recurrence.endsAt !== null &&
    Date.parse(recurrence.startsAt) > Date.parse(recurrence.endsAt)
  ) {
    context.addIssue({ code: "custom", message: "Recurrence ends before it starts." });
  }
});

const riskReferenceSchema = z.object({
  riskId: opaqueIdSchema,
  severity: z.enum(["low", "medium", "high", "critical"]),
  state: z.enum(["open", "mitigated", "accepted", "closed"]),
  evidenceRefIds: uniqueIdsSchema,
}).strict();

const decisionReferenceSchema = z.object({
  decisionId: opaqueIdSchema,
  state: z.enum(["proposed", "accepted", "rejected", "superseded"]),
  evidenceRefIds: uniqueIdsSchema,
}).strict();

const artifactReferenceSchema = z.object({
  artifactId: opaqueIdSchema,
  kind: opaqueIdSchema,
  evidenceRefIds: uniqueIdsSchema,
}).strict();

export const canonicalWorkItemV1Schema = z.object({
  schemaVersion: z.literal(CANONICAL_WORK_MODEL_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  projectId: opaqueIdSchema,
  workItemId: opaqueIdSchema,
  parentWorkItemId: opaqueIdSchema.nullable(),
  kind: z.enum(["task", "milestone"]),
  canonicalStatus: z.enum(CANONICAL_STATUSES),
  statusRevision: positiveRevisionSchema,
  sourceAuthority: z.literal("legacy_project_task"),
  dependencyWorkItemIds: uniqueIdsSchema,
  ownerActorIds: uniqueActorIdsSchema,
  assignedAgents: z.array(assignedAgentSchema).max(32).refine(
    (assignments) => isSortedUnique(assignments.map((item) => item.agentId)),
    { message: "Agent assignments must be sorted and unique." },
  ),
  schedule: scheduleSchema,
  recurrence: recurrenceSchema.nullable(),
  risks: z.array(riskReferenceSchema).max(128).refine(
    (risks) => isSortedUnique(risks.map((item) => item.riskId)),
    { message: "Risks must be sorted and unique." },
  ),
  decisions: z.array(decisionReferenceSchema).max(128).refine(
    (decisions) => isSortedUnique(decisions.map((item) => item.decisionId)),
    { message: "Decisions must be sorted and unique." },
  ),
  artifacts: z.array(artifactReferenceSchema).max(256).refine(
    (artifacts) => isSortedUnique(artifacts.map((item) => item.artifactId)),
    { message: "Artifacts must be sorted and unique." },
  ),
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema,
  terminalAt: canonicalTimestampSchema.nullable(),
}).strict().superRefine((workItem, context) => {
  if (workItem.dependencyWorkItemIds.includes(workItem.workItemId)) {
    context.addIssue({ code: "custom", message: "A WorkItem cannot depend on itself." });
  }
  const terminal = ["failed", "canceled", "succeeded"].includes(workItem.canonicalStatus);
  if (terminal !== (workItem.terminalAt !== null)) {
    context.addIssue({ code: "custom", message: "WorkItem terminal state is inconsistent." });
  }
  addChronologyIssue(workItem.createdAt, workItem.updatedAt, workItem.terminalAt, context);
});

export const canonicalWorkCompatibilityV1Schema = z.object({
  schemaVersion: z.literal(CANONICAL_WORK_MODEL_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  mappingId: opaqueIdSchema,
  sourceKind: z.enum([
    "legacy_project",
    "legacy_project_task",
    "legacy_mission",
    "legacy_mission_task",
  ]),
  sourceId: opaqueIdSchema,
  sourceOwnerActorId: opaqueIdSchema,
  canonicalOwnerActorId: canonicalActorIdSchema.nullable(),
  workspaceId: workspaceIdSchema.nullable(),
  projectId: opaqueIdSchema.nullable(),
  workItemId: opaqueIdSchema.nullable(),
  state: z.enum(["active", "quarantined"]),
  quarantineCode: z.enum([
    "actor_unmapped",
    "tenant_membership_missing",
    "scope_ambiguous",
    "parent_mapping_missing",
    "status_conflict",
  ]).nullable(),
  sourceRevisionSha256: sha256Schema,
  mappingRevision: positiveRevisionSchema,
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema,
}).strict().superRefine((mapping, context) => {
  const hasCanonicalTarget =
    mapping.canonicalOwnerActorId !== null &&
    mapping.workspaceId !== null &&
    mapping.projectId !== null;
  if (mapping.state === "active" && (!hasCanonicalTarget || mapping.quarantineCode !== null)) {
    context.addIssue({ code: "custom", message: "Active mapping lacks an exact canonical target." });
  }
  if (mapping.state === "quarantined" && mapping.quarantineCode === null) {
    context.addIssue({ code: "custom", message: "Quarantined mapping lacks a reason." });
  }
  const itemSource = mapping.sourceKind.endsWith("_task");
  if (mapping.state === "active" && itemSource !== (mapping.workItemId !== null)) {
    context.addIssue({ code: "custom", message: "Compatibility target kind is inconsistent." });
  }
  addChronologyIssue(mapping.createdAt, mapping.updatedAt, null, context);
});

export const canonicalWorkEventV1Schema = z.object({
  schemaVersion: z.literal(CANONICAL_WORK_EVENT_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  projectId: opaqueIdSchema,
  workItemId: opaqueIdSchema.nullable(),
  actorId: canonicalActorIdSchema,
  eventType: z.enum([
    "work.workspace.activated",
    "work.project.projected",
    "work.item.projected",
    "work.item.status_changed",
    "work.compatibility.quarantined",
  ]),
  status: z.string().trim().min(1).max(80).nullable(),
  revision: positiveRevisionSchema,
  changedFieldIds: z.array(opaqueIdSchema).max(32).refine(isSortedUnique, {
    message: "Changed fields must be sorted and unique.",
  }),
  sourceRevisionSha256: sha256Schema,
  eventSha256: sha256Schema,
  occurredAt: canonicalTimestampSchema,
}).strict().superRefine((event, context) => {
  const { eventSha256: _eventSha256, ...body } = event;
  if (canonicalJsonSha256(body) !== event.eventSha256) {
    context.addIssue({ code: "custom", message: "Canonical work event digest is invalid." });
  }
});

export type CanonicalWorkspaceV1 = Readonly<z.infer<typeof canonicalWorkspaceV1Schema>>;
export type CanonicalProjectV1 = Readonly<z.infer<typeof canonicalProjectV1Schema>>;
export type CanonicalWorkItemV1 = Readonly<z.infer<typeof canonicalWorkItemV1Schema>>;
export type CanonicalWorkCompatibilityV1 = Readonly<z.infer<typeof canonicalWorkCompatibilityV1Schema>>;
export type CanonicalWorkEventV1 = Readonly<z.infer<typeof canonicalWorkEventV1Schema>>;

export function parseCanonicalWorkspaceV1(value: unknown) {
  return Object.freeze(canonicalWorkspaceV1Schema.parse(value));
}

export function parseCanonicalProjectV1(value: unknown) {
  return Object.freeze(canonicalProjectV1Schema.parse(value));
}

export function parseCanonicalWorkItemV1(value: unknown) {
  return Object.freeze(canonicalWorkItemV1Schema.parse(value));
}

export function parseCanonicalWorkCompatibilityV1(value: unknown) {
  return Object.freeze(canonicalWorkCompatibilityV1Schema.parse(value));
}

export function buildCanonicalWorkEventV1(
  input: Omit<CanonicalWorkEventV1, "schemaVersion" | "eventSha256">,
) {
  const body = {
    schemaVersion: CANONICAL_WORK_EVENT_SCHEMA_VERSION,
    ...input,
    changedFieldIds: [...new Set(input.changedFieldIds)].sort(),
  };
  return Object.freeze(canonicalWorkEventV1Schema.parse({
    ...body,
    eventSha256: canonicalJsonSha256(body),
  }));
}

export function personalWorkspaceId(canonicalActorId: string) {
  const actorId = canonicalActorIdSchema.parse(canonicalActorId);
  return workspaceIdSchema.parse(`workspace:personal:${actorId.slice("actor:".length)}`);
}

function isSortedUnique(values: readonly string[]) {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

function addChronologyIssue(
  createdAt: string,
  updatedAt: string,
  terminalAt: string | null,
  context: z.RefinementCtx,
) {
  if (
    Date.parse(createdAt) > Date.parse(updatedAt) ||
    (terminalAt !== null && (
      Date.parse(terminalAt) < Date.parse(createdAt) ||
      Date.parse(terminalAt) > Date.parse(updatedAt)
    ))
  ) {
    context.addIssue({ code: "custom", message: "Canonical work chronology is invalid." });
  }
}
