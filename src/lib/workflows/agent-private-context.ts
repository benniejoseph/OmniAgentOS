import { z } from "zod";

import {
  agentDefinitionV1Schema,
  agentPrincipalDefinitionV1Schema,
  parseAgentDefinitionV1,
  parseAgentPrincipalDefinitionV1,
  type ResolvedAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import {
  databaseMemoryAccessScopeFromExecutionScope,
  parseDatabaseMemoryAccessScope,
  serializeDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  createExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import type { WorkflowPlanContextBoundaryV1 } from "@/lib/workflows/shared-context";

export const WORKFLOW_AGENT_PRIVATE_CONTEXT_POLICY_VERSION =
  "workflow-agent-private-context-v1" as const;
export const WORKFLOW_AGENT_PRIVATE_CONTEXT_METADATA_KEY =
  "_workflowAgentPrivateContext" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const contractIdSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);

const workflowAgentPrivateContextBindingBodySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(WORKFLOW_AGENT_PRIVATE_CONTEXT_POLICY_VERSION),
  contextScope: z.literal("agent_private"),
  requestingActorId: contractIdSchema,
  agentIdentity: z.object({
    definition: agentDefinitionV1Schema,
    principal: agentPrincipalDefinitionV1Schema,
  }).strict(),
  authoritySha256: sha256Schema,
  databaseAccessScope: z.unknown(),
  workflowExecutionScopeSha256: sha256Schema,
}).strict();

const workflowAgentPrivateContextBindingSchema =
  workflowAgentPrivateContextBindingBodySchema.extend({
    bindingSha256: sha256Schema,
  }).strict();

export type WorkflowAgentPrivatePlanContextBoundaryV1 = Readonly<{
  schemaVersion: 1;
  policyVersion: typeof WORKFLOW_AGENT_PRIVATE_CONTEXT_POLICY_VERSION;
  contextScope: "agent_private";
  agentId: string;
  authoritySha256: string;
}>;

export type WorkflowAgentPrivateContextBindingV1 = Readonly<{
  schemaVersion: 1;
  policyVersion: typeof WORKFLOW_AGENT_PRIVATE_CONTEXT_POLICY_VERSION;
  contextScope: "agent_private";
  requestingActorId: string;
  agentIdentity: ResolvedAgentIdentityV1;
  authoritySha256: string;
  databaseAccessScope: DatabaseMemoryAccessScope;
  workflowExecutionScopeSha256: string;
  bindingSha256: string;
}>;

export function workflowAgentPrivateAuthoritySha256(
  identityValue: ResolvedAgentIdentityV1,
) {
  const identity = parseResolvedAgentIdentity(identityValue);
  return sourceContractSha256({
    contract: WORKFLOW_AGENT_PRIVATE_CONTEXT_POLICY_VERSION,
    definitionSha256: identity.definition.definitionSha256,
    principalSha256: identity.principal.principalSha256,
  });
}

export function workflowAgentPrivatePlanContextBoundary(
  identityValue: ResolvedAgentIdentityV1,
): WorkflowAgentPrivatePlanContextBoundaryV1 {
  const identity = parseResolvedAgentIdentity(identityValue);
  return Object.freeze({
    schemaVersion: 1,
    policyVersion: WORKFLOW_AGENT_PRIVATE_CONTEXT_POLICY_VERSION,
    contextScope: "agent_private",
    agentId: identity.definition.logicalAgentId,
    authoritySha256: workflowAgentPrivateAuthoritySha256(identity),
  });
}

export function workflowAgentPrivateDatabaseAccessScope(input: {
  identity: ResolvedAgentIdentityV1;
  requestingActorId: string;
  correlationId: string;
}): DatabaseMemoryAccessScope {
  const identity = parseResolvedAgentIdentity(input.identity);
  assertActiveIdentity(identity);
  const executionScope = createExecutionScope({
    tenantId: identity.definition.tenantId,
    initiatingActorId: contractIdSchema.parse(input.requestingActorId),
    executingPrincipalType: "agent",
    executingPrincipalId: identity.principal.principalId,
    workspaceId: null,
    projectId: null,
    missionId: null,
    correlationId: input.correlationId,
    contextGrantIds: identity.principal.contextGrantIds,
    capabilityGrantIds: identity.principal.capabilityGrantIds,
    purpose: "agent.context.private.retrieve",
  });
  return databaseMemoryAccessScopeFromExecutionScope(executionScope, {
    purposeId: MEMORY_PURPOSE_IDS.retrieve,
    auditPurpose: "Retrieve memory owned by the exact assigned agent.",
  });
}

export function createWorkflowAgentPrivateContextBinding(input: {
  identity: ResolvedAgentIdentityV1;
  requestingActorId: string;
  workflowExecutionScope: ExecutionScope;
}): WorkflowAgentPrivateContextBindingV1 {
  const identity = parseResolvedAgentIdentity(input.identity);
  assertWorkflowAgentAuthority(
    identity,
    input.requestingActorId,
    input.workflowExecutionScope,
  );
  const body = workflowAgentPrivateContextBindingBodySchema.parse({
    schemaVersion: 1,
    policyVersion: WORKFLOW_AGENT_PRIVATE_CONTEXT_POLICY_VERSION,
    contextScope: "agent_private",
    requestingActorId: input.requestingActorId,
    agentIdentity: identity,
    authoritySha256: workflowAgentPrivateAuthoritySha256(identity),
    databaseAccessScope: workflowAgentPrivateDatabaseAccessScope({
      identity,
      requestingActorId: input.requestingActorId,
      correlationId: input.workflowExecutionScope.correlationId,
    }),
    workflowExecutionScopeSha256: workflowExecutionScopeSha256(
      input.workflowExecutionScope,
    ),
  });
  return Object.freeze({
    ...body,
    agentIdentity: identity,
    databaseAccessScope: parseDatabaseMemoryAccessScope(
      body.databaseAccessScope,
    ),
    bindingSha256: sourceContractSha256(body),
  });
}

export function parseWorkflowAgentPrivateContextBinding(
  value: unknown,
): WorkflowAgentPrivateContextBindingV1 {
  const parsed = workflowAgentPrivateContextBindingSchema.parse(value);
  const { bindingSha256, ...body } = parsed;
  if (sourceContractSha256(body) !== bindingSha256) {
    throw new Error("Workflow Agent-private context binding digest does not match.");
  }
  const identity = parseResolvedAgentIdentity(parsed.agentIdentity);
  const authoritySha256 = workflowAgentPrivateAuthoritySha256(identity);
  if (parsed.authoritySha256 !== authoritySha256) {
    throw new Error("Workflow Agent-private authority digest does not match.");
  }
  return Object.freeze({
    ...parsed,
    agentIdentity: identity,
    databaseAccessScope: parseDatabaseMemoryAccessScope(
      parsed.databaseAccessScope,
    ),
  });
}

/** Re-resolves the active Agent identity before every retrieval or replan. */
export async function resolveWorkflowAgentPrivateContextAccess(input: {
  binding: unknown;
  workflowExecutionScope: ExecutionScope;
}): Promise<Readonly<{
  databaseAccessScope: DatabaseMemoryAccessScope;
  contextBoundary: WorkflowAgentPrivatePlanContextBoundaryV1;
}>> {
  const binding = parseWorkflowAgentPrivateContextBinding(input.binding);
  if (
    binding.workflowExecutionScopeSha256 !==
      workflowExecutionScopeSha256(input.workflowExecutionScope)
  ) {
    throw new Error(
      "Workflow Agent-private context no longer matches its root authority.",
    );
  }
  assertWorkflowAgentAuthority(
    binding.agentIdentity,
    binding.requestingActorId,
    input.workflowExecutionScope,
  );
  const currentIdentity = await resolveAgentIdentityForExecution({
    tenantId: input.workflowExecutionScope.tenantId,
    actorId: binding.requestingActorId,
    agentId: binding.agentIdentity.definition.logicalAgentId,
  });
  assertActiveIdentity(currentIdentity);
  const currentBoundary = workflowAgentPrivatePlanContextBoundary(
    currentIdentity,
  );
  if (currentBoundary.authoritySha256 !== binding.authoritySha256) {
    throw new Error(
      "Workflow Agent-private identity or grants changed after review.",
    );
  }
  const currentDatabaseAccessScope = workflowAgentPrivateDatabaseAccessScope({
    identity: currentIdentity,
    requestingActorId: binding.requestingActorId,
    correlationId: input.workflowExecutionScope.correlationId,
  });
  if (
    serializeDatabaseMemoryAccessScope(currentDatabaseAccessScope) !==
      serializeDatabaseMemoryAccessScope(binding.databaseAccessScope)
  ) {
    throw new Error("Workflow Agent-private access envelope changed after review.");
  }
  return Object.freeze({
    databaseAccessScope: currentDatabaseAccessScope,
    contextBoundary: currentBoundary,
  });
}

function parseResolvedAgentIdentity(value: unknown): ResolvedAgentIdentityV1 {
  const candidate = z.object({
    definition: z.unknown(),
    principal: z.unknown(),
  }).strict().parse(value);
  const definition = parseAgentDefinitionV1(candidate.definition);
  const principal = parseAgentPrincipalDefinitionV1(candidate.principal);
  if (
    definition.tenantId !== principal.tenantId ||
    definition.ownerActorId !== principal.controllerActorId ||
    definition.logicalAgentId !== principal.logicalAgentId ||
    definition.definitionId !== principal.definitionId
  ) {
    throw new Error("Workflow Agent-private identity is inconsistent.");
  }
  return Object.freeze({ definition, principal });
}

function assertActiveIdentity(identityValue: ResolvedAgentIdentityV1) {
  const identity = parseResolvedAgentIdentity(identityValue);
  if (
    identity.principal.state !== "active" ||
    (identity.principal.expiresAt !== null &&
      Date.parse(identity.principal.expiresAt) <= Date.now())
  ) {
    throw new Error("Workflow Agent-private identity is not active.");
  }
}

function assertWorkflowAgentAuthority(
  identityValue: ResolvedAgentIdentityV1,
  requestingActorIdValue: string,
  workflowExecutionScope: ExecutionScope,
) {
  const identity = parseResolvedAgentIdentity(identityValue);
  assertActiveIdentity(identity);
  const requestingActorId = contractIdSchema.parse(requestingActorIdValue);
  if (
    workflowExecutionScope.tenantId !== identity.definition.tenantId ||
    workflowExecutionScope.initiatingActorId !== requestingActorId ||
    workflowExecutionScope.executingPrincipalType !== "agent" ||
    workflowExecutionScope.executingPrincipalId !==
      identity.principal.principalId ||
    !sameIds(
      workflowExecutionScope.contextGrantIds,
      identity.principal.contextGrantIds,
    ) ||
    !sameIds(
      workflowExecutionScope.capabilityGrantIds,
      identity.principal.capabilityGrantIds,
    ) ||
    workflowExecutionScope.purpose !== "workflow.run"
  ) {
    throw new Error(
      "Workflow Agent-private context does not match its execution authority.",
    );
  }
}

function workflowExecutionScopeSha256(executionScope: ExecutionScope) {
  return sourceContractSha256({
    contract: "workflow-execution-scope-v1",
    executionScope,
  });
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function isWorkflowAgentPrivatePlanContextBoundary(
  value: WorkflowPlanContextBoundaryV1 | undefined,
): value is WorkflowAgentPrivatePlanContextBoundaryV1 {
  return value?.contextScope === "agent_private";
}
