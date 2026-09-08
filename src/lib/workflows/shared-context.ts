import { z } from "zod";

import {
  parseDatabaseMemoryAccessScope,
  serializeDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  resolveSharedContextAuthority,
  sharedContextAuthorityV1Schema,
  type RequestSharedMemoryAccessV1,
  type SharedContextAuthorityV1,
} from "@/lib/memory/shared-context";
import type { ContextScopeId } from "@/lib/rag/context-scope";
import {
  createExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const WORKFLOW_SHARED_CONTEXT_POLICY_VERSION =
  "workflow-shared-context-v1" as const;
export const WORKFLOW_SHARED_CONTEXT_METADATA_KEY =
  "_workflowSharedContext" as const;

export const WORKFLOW_SHARED_CONTEXT_SCOPE_IDS = [
  "mission",
  "project",
  "workspace",
] as const;
export type WorkflowSharedContextScopeId =
  (typeof WORKFLOW_SHARED_CONTEXT_SCOPE_IDS)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const actorBindingSchema = z.object({
  version: z.literal(1),
  kind: z.literal("auth_user"),
  authUserId: z.string().uuid(),
  canonicalActorId: z.string().min(1).max(240),
  legacyOwnerActorIds: z.array(z.string().min(1).max(320)).min(1).max(4),
  readableOwnerActorIds: z.array(z.string().min(1).max(320)).min(2).max(5),
}).strict();

const workflowSharedPlanContextBoundarySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(WORKFLOW_SHARED_CONTEXT_POLICY_VERSION),
  contextScope: z.enum(WORKFLOW_SHARED_CONTEXT_SCOPE_IDS),
  authoritySha256: sha256Schema,
}).strict();

const workflowAgentPrivatePlanContextBoundarySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal("workflow-agent-private-context-v1"),
  contextScope: z.literal("agent_private"),
  agentId: z.string().trim().min(1).max(240),
  authoritySha256: sha256Schema,
}).strict();

const workflowPlanContextBoundarySchema = z.union([
  workflowSharedPlanContextBoundarySchema,
  workflowAgentPrivatePlanContextBoundarySchema,
]);

export type WorkflowPlanContextBoundaryV1 = Readonly<
  z.infer<typeof workflowPlanContextBoundarySchema>
>;
export type WorkflowSharedPlanContextBoundaryV1 = Readonly<
  z.infer<typeof workflowSharedPlanContextBoundarySchema>
>;

const workflowSharedContextBindingBodySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(WORKFLOW_SHARED_CONTEXT_POLICY_VERSION),
  contextScope: z.enum(WORKFLOW_SHARED_CONTEXT_SCOPE_IDS),
  actorBinding: actorBindingSchema,
  authority: sharedContextAuthorityV1Schema,
  promptExecutionScope: z.unknown(),
  databaseAccessScope: z.unknown(),
  workflowExecutionScopeSha256: sha256Schema,
}).strict();

const workflowSharedContextBindingSchema = workflowSharedContextBindingBodySchema
  .extend({ bindingSha256: sha256Schema })
  .strict();

export type WorkflowSharedContextBindingV1 = Readonly<{
  schemaVersion: 1;
  policyVersion: typeof WORKFLOW_SHARED_CONTEXT_POLICY_VERSION;
  contextScope: WorkflowSharedContextScopeId;
  actorBinding: RequestSharedMemoryAccessV1["actorBinding"];
  authority: SharedContextAuthorityV1;
  promptExecutionScope: ExecutionScope;
  databaseAccessScope: DatabaseMemoryAccessScope;
  workflowExecutionScopeSha256: string;
  bindingSha256: string;
}>;

export function isWorkflowSharedContextScope(
  value: ContextScopeId | string | undefined,
): value is WorkflowSharedContextScopeId {
  return WORKFLOW_SHARED_CONTEXT_SCOPE_IDS.includes(
    value as WorkflowSharedContextScopeId,
  );
}

export function workflowPlanContextBoundary(
  access: RequestSharedMemoryAccessV1,
  contextScope: WorkflowSharedContextScopeId,
): WorkflowSharedPlanContextBoundaryV1 {
  assertAccessMatchesContextScope(access, contextScope);
  return Object.freeze(workflowSharedPlanContextBoundarySchema.parse({
    schemaVersion: 1,
    policyVersion: WORKFLOW_SHARED_CONTEXT_POLICY_VERSION,
    contextScope,
    authoritySha256: access.authority.authoritySha256,
  }));
}

export function parseWorkflowPlanContextBoundary(
  value: unknown,
): WorkflowPlanContextBoundaryV1 | undefined {
  if (value === undefined || value === null) return undefined;
  return Object.freeze(workflowPlanContextBoundarySchema.parse(value));
}

export function workflowPlanContextBoundariesEqual(
  left: WorkflowPlanContextBoundaryV1 | undefined,
  right: WorkflowPlanContextBoundaryV1 | undefined,
) {
  if (!left || !right) return left === right;
  return sourceContractSha256(parseWorkflowPlanContextBoundary(left)) ===
    sourceContractSha256(parseWorkflowPlanContextBoundary(right));
}

export function createWorkflowSharedContextBinding(input: {
  access: RequestSharedMemoryAccessV1;
  contextScope: WorkflowSharedContextScopeId;
  workflowExecutionScope: ExecutionScope;
}): WorkflowSharedContextBindingV1 {
  const access = normalizeRequestSharedMemoryAccess(input.access);
  assertAccessMatchesContextScope(access, input.contextScope);
  assertWorkflowExecutionScope(access, input.contextScope, input.workflowExecutionScope);
  const body = workflowSharedContextBindingBodySchema.parse({
    schemaVersion: 1,
    policyVersion: WORKFLOW_SHARED_CONTEXT_POLICY_VERSION,
    contextScope: input.contextScope,
    actorBinding: access.actorBinding,
    authority: access.authority,
    promptExecutionScope: access.executionScope,
    databaseAccessScope: access.databaseAccessScope,
    workflowExecutionScopeSha256: workflowExecutionScopeSha256(
      input.workflowExecutionScope,
    ),
  });
  return Object.freeze({
    ...body,
    promptExecutionScope: access.executionScope,
    databaseAccessScope: access.databaseAccessScope,
    bindingSha256: sourceContractSha256(body),
  }) as WorkflowSharedContextBindingV1;
}

export function parseWorkflowSharedContextBinding(
  value: unknown,
): WorkflowSharedContextBindingV1 {
  const parsed = workflowSharedContextBindingSchema.parse(value);
  const { bindingSha256, ...body } = parsed;
  if (sourceContractSha256(body) !== bindingSha256) {
    throw new Error("Workflow shared-context binding digest does not match.");
  }
  const access = normalizeRequestSharedMemoryAccess({
    actorBinding: parsed.actorBinding,
    authority: parsed.authority,
    executionScope: parsed.promptExecutionScope,
    databaseAccessScope: parsed.databaseAccessScope,
  });
  assertAccessMatchesContextScope(access, parsed.contextScope);
  return Object.freeze({
    ...parsed,
    promptExecutionScope: access.executionScope,
    databaseAccessScope: access.databaseAccessScope,
  }) as WorkflowSharedContextBindingV1;
}

/**
 * Revalidates the current canonical membership before each workflow retrieval
 * or replan. The persisted envelope is evidence of the reviewed boundary, not
 * standing authority.
 */
export async function resolveWorkflowSharedContextAccess(input: {
  binding: unknown;
  workflowExecutionScope: ExecutionScope;
}): Promise<Readonly<{
  databaseAccessScope: DatabaseMemoryAccessScope;
  contextBoundary: WorkflowPlanContextBoundaryV1;
}>> {
  const binding = parseWorkflowSharedContextBinding(input.binding);
  if (
    binding.workflowExecutionScopeSha256 !==
      workflowExecutionScopeSha256(input.workflowExecutionScope)
  ) {
    throw new Error("Workflow shared context no longer matches its root authority.");
  }
  const access = normalizeRequestSharedMemoryAccess({
    actorBinding: binding.actorBinding,
    authority: binding.authority,
    executionScope: binding.promptExecutionScope,
    databaseAccessScope: binding.databaseAccessScope,
  });
  assertWorkflowExecutionScope(
    access,
    binding.contextScope,
    input.workflowExecutionScope,
  );
  const currentAuthority = await resolveSharedContextAuthority({
    tenantId: binding.authority.tenantId,
    canonicalActorId: binding.authority.initiatingActorId,
    scope: binding.authority.scope,
    ...(binding.authority.scope === "project"
      ? { projectId: binding.authority.requestedProjectId || undefined }
      : { workspaceId: binding.authority.workspaceId }),
  });
  if (currentAuthority.authoritySha256 !== binding.authority.authoritySha256) {
    throw new Error("Workflow shared context membership changed after review.");
  }
  return Object.freeze({
    databaseAccessScope: access.databaseAccessScope,
    contextBoundary: workflowPlanContextBoundary(access, binding.contextScope),
  });
}

function normalizeRequestSharedMemoryAccess(
  value: {
    actorBinding: unknown;
    authority: unknown;
    executionScope: unknown;
    databaseAccessScope: unknown;
  },
): RequestSharedMemoryAccessV1 {
  const actorBinding = actorBindingSchema.parse(value.actorBinding);
  const expectedCanonicalActorId = `actor:${actorBinding.authUserId}`;
  if (
    actorBinding.canonicalActorId !== expectedCanonicalActorId ||
    !actorBinding.readableOwnerActorIds.includes(expectedCanonicalActorId) ||
    actorBinding.legacyOwnerActorIds.some(
      (actorId) => !actorBinding.readableOwnerActorIds.includes(actorId),
    )
  ) {
    throw new Error("Workflow shared-context actor binding is invalid.");
  }
  const authority = sharedContextAuthorityV1Schema.parse(value.authority);
  const executionScope = parsePersistedExecutionScope(value.executionScope);
  if (!executionScope) {
    throw new Error("Workflow shared-context execution scope is missing.");
  }
  const databaseAccessScope = parseDatabaseMemoryAccessScope(
    value.databaseAccessScope,
  );
  const expectedPromptScope = createExecutionScope({
    tenantId: authority.tenantId,
    initiatingActorId: actorBinding.canonicalActorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorBinding.canonicalActorId,
    workspaceId: authority.workspaceId,
    projectId: authority.projectId,
    correlationId: executionScope.correlationId,
    purpose: "agent.context.shared.retrieve",
  });
  const expectedDatabaseScope = parseDatabaseMemoryAccessScope({
    version: 1,
    tenantId: expectedPromptScope.tenantId,
    initiatingActorId: expectedPromptScope.initiatingActorId,
    executingPrincipalType: expectedPromptScope.executingPrincipalType,
    executingPrincipalId: expectedPromptScope.executingPrincipalId,
    workspaceId: expectedPromptScope.workspaceId,
    projectId: expectedPromptScope.projectId,
    missionId: expectedPromptScope.missionId,
    contextGrantIds: expectedPromptScope.contextGrantIds,
    capabilityGrantIds: expectedPromptScope.capabilityGrantIds,
    purposeId: MEMORY_PURPOSE_IDS.retrieve,
    purpose: "Retrieve explicitly selected shared workspace context.",
  });
  if (
    executionScope.tenantId !== expectedPromptScope.tenantId ||
    executionScope.initiatingActorId !== expectedPromptScope.initiatingActorId ||
    executionScope.executingPrincipalType !== expectedPromptScope.executingPrincipalType ||
    executionScope.executingPrincipalId !== expectedPromptScope.executingPrincipalId ||
    executionScope.workspaceId !== expectedPromptScope.workspaceId ||
    executionScope.projectId !== expectedPromptScope.projectId ||
    executionScope.missionId !== null ||
    executionScope.delegationId !== null ||
    executionScope.contextGrantIds.length !== 0 ||
    executionScope.capabilityGrantIds.length !== 0 ||
    executionScope.purpose !== expectedPromptScope.purpose ||
    authority.initiatingActorId !== actorBinding.canonicalActorId ||
    serializeDatabaseMemoryAccessScope(databaseAccessScope) !==
      serializeDatabaseMemoryAccessScope(expectedDatabaseScope)
  ) {
    throw new Error("Workflow shared-context access envelope is invalid.");
  }
  return Object.freeze({
    actorBinding,
    authority,
    executionScope,
    databaseAccessScope,
  });
}

function assertAccessMatchesContextScope(
  access: RequestSharedMemoryAccessV1,
  contextScope: WorkflowSharedContextScopeId,
) {
  const authority = sharedContextAuthorityV1Schema.parse(access.authority);
  const expectedAuthorityScope = contextScope === "workspace"
    ? "workspace"
    : "project";
  if (
    authority.scope !== expectedAuthorityScope ||
    (contextScope !== "workspace" && !authority.requestedProjectId) ||
    (contextScope === "workspace" && authority.projectId !== null)
  ) {
    throw new Error("Workflow shared context does not match the selected scope.");
  }
}

function assertWorkflowExecutionScope(
  access: RequestSharedMemoryAccessV1,
  contextScope: WorkflowSharedContextScopeId,
  workflowExecutionScope: ExecutionScope,
) {
  const expectedMissionId = contextScope === "mission"
    ? access.authority.requestedProjectId
    : null;
  if (
    workflowExecutionScope.tenantId !== access.authority.tenantId ||
    !workflowExecutionScope.initiatingActorId ||
    !access.actorBinding.readableOwnerActorIds.includes(
      workflowExecutionScope.initiatingActorId,
    ) ||
    (contextScope === "mission" &&
      workflowExecutionScope.missionId !== expectedMissionId) ||
    workflowExecutionScope.correlationId !== access.executionScope.correlationId ||
    workflowExecutionScope.purpose !== "workflow.run"
  ) {
    throw new Error("Workflow shared context does not match its execution scope.");
  }
}

function workflowExecutionScopeSha256(executionScope: ExecutionScope) {
  return sourceContractSha256({
    contract: "workflow-execution-scope-v1",
    executionScope,
  });
}
