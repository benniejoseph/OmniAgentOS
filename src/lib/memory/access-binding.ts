import { z } from "zod";

import type { DatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const MEMORY_ACCESS_BINDING_VERSION = 1 as const;

export const MEMORY_PURPOSE_IDS = Object.freeze({
  read: "memory.read.v1",
  retrieve: "memory.retrieve.v1",
  write: "memory.write.v1",
  correct: "memory.correct.v1",
  forget: "memory.forget.v1",
  formation: "memory.formation.v1",
  maintenance: "memory.maintenance.v1",
  export: "memory.export.v1",
});

const contractIdSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const timestampSchema = z.string().datetime({ offset: true });

export const memoryAccessBindingV1Schema = z.object({
  version: z.literal(MEMORY_ACCESS_BINDING_VERSION),
  state: z.literal("scope_bound"),
  tenantId: contractIdSchema,
  ownerActorId: contractIdSchema,
  ownerAgentId: contractIdSchema.nullable(),
  workspaceId: contractIdSchema.nullable(),
  projectId: contractIdSchema.nullable(),
  missionId: contractIdSchema.nullable(),
  visibility: z.enum([
    "agent_private",
    "user_private",
    "mission_shared",
    "project_shared",
    "workspace_shared",
  ]),
  sensitivity: z.enum([
    "public",
    "internal",
    "confidential",
    "restricted",
  ]),
  originPurpose: z.string().trim().min(1).max(500),
  allowedPurposeIds: z.array(contractIdSchema).min(1).max(32),
  accessScopeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  accessBoundAt: timestampSchema,
}).strict().superRefine((binding, context) => {
  if (!canonicalIds(binding.allowedPurposeIds)) {
    context.addIssue({
      code: "custom",
      path: ["allowedPurposeIds"],
      message: "Memory purpose IDs must be C-sorted and unique.",
    });
  }
  const requiredScope = binding.visibility === "agent_private"
    ? binding.ownerAgentId
    : binding.visibility === "mission_shared"
      ? binding.missionId
      : binding.visibility === "project_shared"
        ? binding.projectId
        : binding.visibility === "workspace_shared"
          ? binding.workspaceId
          : binding.ownerActorId;
  if (!requiredScope) {
    context.addIssue({
      code: "custom",
      path: ["visibility"],
      message: "Memory visibility is missing its required scope.",
    });
  }
  if (binding.accessScopeSha256 !== memoryAccessBindingSha256(binding)) {
    context.addIssue({
      code: "custom",
      path: ["accessScopeSha256"],
      message: "Memory access binding digest does not match.",
    });
  }
});

export type MemoryAccessBindingV1 = Readonly<
  Omit<z.infer<typeof memoryAccessBindingV1Schema>, "allowedPurposeIds"> & {
    allowedPurposeIds: readonly string[];
  }
>;

export function buildUserPrivateMemoryAccessBindingV1(input: {
  tenantId: string;
  ownerActorId: string;
  originPurpose: string;
  allowedPurposeIds?: readonly string[];
  sensitivity?: MemoryAccessBindingV1["sensitivity"];
  accessBoundAt?: string;
}): MemoryAccessBindingV1 {
  const draft = {
    version: MEMORY_ACCESS_BINDING_VERSION,
    state: "scope_bound" as const,
    tenantId: contractIdSchema.parse(input.tenantId),
    ownerActorId: contractIdSchema.parse(input.ownerActorId),
    ownerAgentId: null,
    workspaceId: null,
    projectId: null,
    missionId: null,
    visibility: "user_private" as const,
    sensitivity: input.sensitivity || "confidential" as const,
    originPurpose: input.originPurpose.trim(),
    allowedPurposeIds: Object.freeze(
      [...new Set(input.allowedPurposeIds || [
        MEMORY_PURPOSE_IDS.read,
        MEMORY_PURPOSE_IDS.retrieve,
        MEMORY_PURPOSE_IDS.write,
        MEMORY_PURPOSE_IDS.correct,
        MEMORY_PURPOSE_IDS.forget,
        MEMORY_PURPOSE_IDS.export,
      ])].sort(compareIds),
    ),
    accessBoundAt: new Date(input.accessBoundAt || Date.now()).toISOString(),
  };
  const parsed = memoryAccessBindingV1Schema.parse({
    ...draft,
    accessScopeSha256: memoryAccessBindingSha256(draft),
  });
  return Object.freeze({
    ...parsed,
    allowedPurposeIds: Object.freeze(parsed.allowedPurposeIds),
  });
}

export function memoryAccessBindingAllows(
  scope: DatabaseMemoryAccessScope,
  candidate: unknown,
) {
  const parsed = memoryAccessBindingV1Schema.safeParse(candidate);
  if (!parsed.success) return false;
  const binding = parsed.data;
  if (
    binding.tenantId !== scope.tenantId ||
    !binding.allowedPurposeIds.includes(scope.purposeId)
  ) {
    return false;
  }
  if (binding.visibility === "user_private") {
    return binding.ownerActorId === scope.initiatingActorId;
  }
  if (binding.visibility === "agent_private") {
    return scope.executingPrincipalType === "agent" &&
      binding.ownerAgentId === scope.executingPrincipalId;
  }
  if (binding.visibility === "mission_shared") {
    return binding.missionId === scope.missionId;
  }
  if (binding.visibility === "project_shared") {
    return binding.projectId === scope.projectId;
  }
  return binding.workspaceId === scope.workspaceId;
}

export function memoryAccessBindingSha256(
  binding: Omit<MemoryAccessBindingV1, "accessScopeSha256"> |
    MemoryAccessBindingV1,
) {
  return sourceContractSha256({
    version: binding.version,
    state: binding.state,
    tenantId: binding.tenantId,
    ownerActorId: binding.ownerActorId,
    ownerAgentId: binding.ownerAgentId,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    missionId: binding.missionId,
    visibility: binding.visibility,
    sensitivity: binding.sensitivity,
    originPurpose: binding.originPurpose,
    allowedPurposeIds: binding.allowedPurposeIds,
    accessBoundAt: binding.accessBoundAt,
  });
}

function canonicalIds(values: readonly string[]) {
  return values.every((value, index) =>
    index === 0 || compareIds(values[index - 1], value) < 0
  );
}

function compareIds(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right));
}
