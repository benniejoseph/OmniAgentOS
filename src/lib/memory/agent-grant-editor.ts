import { z } from "zod";

import {
  memoryAccessGrantRecordV1Schema,
  memoryGrantPurposeIdSchema,
  memoryGrantVisibilitySchema,
  type MemoryAccessGrantRecordV1,
} from "@/lib/memory/grant-contracts";

export const AGENT_MEMORY_GRANT_EDITOR_SCHEMA_VERSION = 1 as const;

const opaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);
const resourceIdsSchema = z.array(opaqueIdSchema).min(1).max(128);

const targetSchema = z.object({
  visibility: memoryGrantVisibilitySchema,
  resourceIds: resourceIdsSchema,
  workspaceId: opaqueIdSchema.nullable().default(null),
  projectId: opaqueIdSchema.nullable().default(null),
  missionId: opaqueIdSchema.nullable().default(null),
}).strict().superRefine((target, context) => {
  const valid =
    ((target.visibility === "agent_private" ||
      target.visibility === "user_private") &&
      target.workspaceId === null &&
      target.projectId === null &&
      target.missionId === null) ||
    (target.visibility === "mission_shared" &&
      target.workspaceId === null &&
      target.projectId === null &&
      target.missionId !== null) ||
    (target.visibility === "project_shared" &&
      target.workspaceId?.startsWith("workspace:") === true &&
      target.projectId !== null &&
      target.missionId === null) ||
    (target.visibility === "workspace_shared" &&
      target.workspaceId?.startsWith("workspace:") === true &&
      target.projectId === null &&
      target.missionId === null);
  if (!valid) {
    context.addIssue({
      code: "custom",
      message: "Grant target coordinates do not match the selected scope.",
    });
  }
});

const commonFields = {
  schemaVersion: z.literal(AGENT_MEMORY_GRANT_EDITOR_SCHEMA_VERSION),
  purposeId: memoryGrantPurposeIdSchema,
  target: targetSchema,
  expiresAt: canonicalTimestampSchema,
};

const contextGrantDraftSchema = z.object({
  ...commonFields,
  grantKind: z.literal("context"),
  purposeId: z.enum(["memory.read.v1", "memory.retrieve.v1"]),
  maxItems: z.number().int().min(1).max(1_000),
  maxBytes: z.number().int().min(1).max(10_000_000),
}).strict();

const capabilityGrantDraftSchema = z.object({
  ...commonFields,
  grantKind: z.literal("capability"),
  operationIds: z.array(memoryGrantPurposeIdSchema).min(1).max(8),
  maxInvocations: z.number().int().min(1).max(10_000),
  maxCostMicrousd: z.number().int().min(1).max(100_000_000),
  maxDurationMs: z.number().int().min(1).max(3_600_000),
}).strict().superRefine((draft, context) => {
  if (!draft.operationIds.includes(draft.purposeId)) {
    context.addIssue({
      code: "custom",
      path: ["operationIds"],
      message: "A capability grant must include its exact purpose operation.",
    });
  }
});

export const agentMemoryGrantDraftV1Schema = z.discriminatedUnion(
  "grantKind",
  [contextGrantDraftSchema, capabilityGrantDraftSchema],
);

export type AgentMemoryGrantDraftV1 = Readonly<
  z.infer<typeof agentMemoryGrantDraftV1Schema>
>;

export type AgentMemoryGrantViewV1 = Readonly<{
  record: MemoryAccessGrantRecordV1;
  explanation: string;
  manageable: boolean;
}>;

const purposeLabels: Record<z.infer<typeof memoryGrantPurposeIdSchema>, string> = {
  "memory.read.v1": "inspect",
  "memory.retrieve.v1": "retrieve",
  "memory.write.v1": "create",
  "memory.correct.v1": "correct",
  "memory.forget.v1": "permanently delete",
  "memory.formation.v1": "form",
  "memory.maintenance.v1": "maintain",
  "memory.export.v1": "export",
};

const visibilityLabels: Record<z.infer<typeof memoryGrantVisibilitySchema>, string> = {
  agent_private: "this Agent's private memory",
  user_private: "your private memory",
  mission_shared: "one mission's shared memory",
  project_shared: "one project's shared memory",
  workspace_shared: "one workspace's shared memory",
};

export function parseAgentMemoryGrantDraftV1(
  value: unknown,
): AgentMemoryGrantDraftV1 {
  const parsed = agentMemoryGrantDraftV1Schema.parse(value);
  const target = Object.freeze({
    ...parsed.target,
    resourceIds: canonicalIds(parsed.target.resourceIds),
  });
  if (parsed.grantKind === "context") {
    return Object.freeze({ ...parsed, target });
  }
  return Object.freeze({
    ...parsed,
    target,
    operationIds: canonicalIds(parsed.operationIds) as typeof parsed.operationIds,
  });
}

export function explainAgentMemoryGrantV1(
  value: unknown,
): string {
  const grant = memoryAccessGrantRecordV1Schema.parse(value);
  const action = grant.grantKind === "context"
    ? `see up to ${grant.maxItems} items / ${formatBytes(grant.maxBytes)}`
    : `${purposeLabels[grant.purposeId]} it up to ${grant.maxInvocations} times / ${formatUsd(grant.maxCostMicrousd)}`;
  const coordinates = [
    grant.target.workspaceId,
    grant.target.projectId,
    grant.target.missionId,
  ].filter((entry): entry is string => Boolean(entry));
  const target = coordinates.length
    ? `${visibilityLabels[grant.target.visibility]} (${coordinates.join(" · ")})`
    : visibilityLabels[grant.target.visibility];
  const state = grant.state === "active"
    ? `until ${formatTime(grant.expiresAt)}`
    : grant.state === "revoked"
      ? `revoked ${formatTime(grant.revokedAt || grant.updatedAt)}`
      : "pending activation";
  return `Can ${action} from ${target}; ${grant.target.resourceIds.length} exact target${grant.target.resourceIds.length === 1 ? "" : "s"}; ${state}.`;
}

function canonicalIds(values: readonly string[]) {
  return Object.freeze([...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "variant" })
  ));
}

function formatBytes(value: number) {
  return value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(1))} MB`
    : value >= 1_000
      ? `${Number((value / 1_000).toFixed(1))} KB`
      : `${value} bytes`;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value / 1_000_000);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
