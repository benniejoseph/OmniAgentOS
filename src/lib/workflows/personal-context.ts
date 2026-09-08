import { z } from "zod";

import {
  databaseMemoryAccessScopeFromExecutionScope,
  parseDatabaseMemoryAccessScope,
  serializeDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  PERSONAL_CONTEXT_RETRIEVAL_PURPOSE,
  type RequestPersonalContextMemoryAccessV1,
} from "@/lib/memory/personal-context-access";
import {
  personalContextConsentAuthorityV1Schema,
  type PersonalContextConsentAuthorityV1,
} from "@/lib/memory/personal-context-consent";
import { requireActivePersonalContextConsent } from "@/lib/memory/personal-context-consent-store";
import {
  createExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const WORKFLOW_PERSONAL_CONTEXT_POLICY_VERSION =
  "workflow-personal-context-v1" as const;
export const WORKFLOW_PERSONAL_CONTEXT_METADATA_KEY =
  "_workflowPersonalContext" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const actorBindingSchema = z.object({
  version: z.literal(1),
  kind: z.literal("auth_user"),
  authUserId: z.string().uuid(),
  canonicalActorId: z.string().min(1).max(240),
  legacyOwnerActorIds: z.array(z.string().min(1).max(320)).min(1).max(4),
  readableOwnerActorIds: z.array(z.string().min(1).max(320)).min(2).max(5),
}).strict();

const workflowPersonalContextBindingBodySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(WORKFLOW_PERSONAL_CONTEXT_POLICY_VERSION),
  contextScope: z.literal("personal"),
  actorBinding: actorBindingSchema,
  consentAuthority: personalContextConsentAuthorityV1Schema,
  promptExecutionScope: z.unknown(),
  databaseAccessScope: z.unknown(),
  workflowExecutionScopeSha256: sha256Schema,
}).strict();

const workflowPersonalContextBindingSchema =
  workflowPersonalContextBindingBodySchema.extend({
    bindingSha256: sha256Schema,
  }).strict();

export type WorkflowPersonalPlanContextBoundaryV1 = Readonly<{
  schemaVersion: 1;
  policyVersion: typeof WORKFLOW_PERSONAL_CONTEXT_POLICY_VERSION;
  contextScope: "personal";
  authoritySha256: string;
}>;

export type WorkflowPersonalContextBindingV1 = Readonly<{
  schemaVersion: 1;
  policyVersion: typeof WORKFLOW_PERSONAL_CONTEXT_POLICY_VERSION;
  contextScope: "personal";
  actorBinding: RequestPersonalContextMemoryAccessV1["actorBinding"];
  consentAuthority: PersonalContextConsentAuthorityV1;
  promptExecutionScope: ExecutionScope;
  databaseAccessScope: DatabaseMemoryAccessScope;
  workflowExecutionScopeSha256: string;
  bindingSha256: string;
}>;

export function workflowPersonalPlanContextBoundary(
  accessValue: RequestPersonalContextMemoryAccessV1,
): WorkflowPersonalPlanContextBoundaryV1 {
  const access = normalizePersonalContextAccess(accessValue);
  return Object.freeze({
    schemaVersion: 1,
    policyVersion: WORKFLOW_PERSONAL_CONTEXT_POLICY_VERSION,
    contextScope: "personal",
    authoritySha256: access.consentAuthority.authoritySha256,
  });
}

export function createWorkflowPersonalContextBinding(input: {
  access: RequestPersonalContextMemoryAccessV1;
  workflowExecutionScope: ExecutionScope;
}): WorkflowPersonalContextBindingV1 {
  const access = normalizePersonalContextAccess(input.access);
  assertWorkflowExecutionScope(access, input.workflowExecutionScope);
  const body = workflowPersonalContextBindingBodySchema.parse({
    schemaVersion: 1,
    policyVersion: WORKFLOW_PERSONAL_CONTEXT_POLICY_VERSION,
    contextScope: "personal",
    actorBinding: access.actorBinding,
    consentAuthority: access.consentAuthority,
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
  }) as WorkflowPersonalContextBindingV1;
}

export function parseWorkflowPersonalContextBinding(
  value: unknown,
): WorkflowPersonalContextBindingV1 {
  const parsed = workflowPersonalContextBindingSchema.parse(value);
  const { bindingSha256, ...body } = parsed;
  if (sourceContractSha256(body) !== bindingSha256) {
    throw new Error("Workflow personal-context binding digest does not match.");
  }
  const access = normalizePersonalContextAccess({
    schemaVersion: 1,
    actorBinding: parsed.actorBinding,
    consentAuthority: parsed.consentAuthority,
    executionScope: parsed.promptExecutionScope as ExecutionScope,
    databaseAccessScope: parsed.databaseAccessScope as DatabaseMemoryAccessScope,
  });
  return Object.freeze({
    ...parsed,
    actorBinding: access.actorBinding,
    consentAuthority: access.consentAuthority,
    promptExecutionScope: access.executionScope,
    databaseAccessScope: access.databaseAccessScope,
  }) as WorkflowPersonalContextBindingV1;
}

/** Revalidates active owner consent before every retrieval or replan. */
export async function resolveWorkflowPersonalContextAccess(input: {
  binding: unknown;
  workflowExecutionScope: ExecutionScope;
}): Promise<Readonly<{
  databaseAccessScope: DatabaseMemoryAccessScope;
  contextBoundary: WorkflowPersonalPlanContextBoundaryV1;
}>> {
  const binding = parseWorkflowPersonalContextBinding(input.binding);
  if (
    binding.workflowExecutionScopeSha256 !==
      workflowExecutionScopeSha256(input.workflowExecutionScope)
  ) {
    throw new Error(
      "Workflow personal context no longer matches its root authority.",
    );
  }
  const access = normalizePersonalContextAccess({
    schemaVersion: 1,
    actorBinding: binding.actorBinding,
    consentAuthority: binding.consentAuthority,
    executionScope: binding.promptExecutionScope,
    databaseAccessScope: binding.databaseAccessScope,
  });
  assertWorkflowExecutionScope(access, input.workflowExecutionScope);
  const currentAuthority = await requireActivePersonalContextConsent({
    tenantId: access.consentAuthority.tenantId,
    actorBinding: access.actorBinding,
    expectedAuthoritySha256: access.consentAuthority.authoritySha256,
  });
  if (currentAuthority.authoritySha256 !== binding.consentAuthority.authoritySha256) {
    throw new Error("Workflow personal-context consent changed after review.");
  }
  return Object.freeze({
    databaseAccessScope: access.databaseAccessScope,
    contextBoundary: workflowPersonalPlanContextBoundary(access),
  });
}

function normalizePersonalContextAccess(
  value: RequestPersonalContextMemoryAccessV1,
): RequestPersonalContextMemoryAccessV1 {
  if (value.schemaVersion !== 1) {
    throw new Error("Workflow personal-context access version is invalid.");
  }
  const actorBinding = actorBindingSchema.parse(value.actorBinding);
  const canonicalActorId = `actor:${actorBinding.authUserId}`;
  if (
    actorBinding.canonicalActorId !== canonicalActorId ||
    !actorBinding.readableOwnerActorIds.includes(canonicalActorId) ||
    actorBinding.legacyOwnerActorIds.some(
      (actorId) => !actorBinding.readableOwnerActorIds.includes(actorId),
    ) ||
    new Set(actorBinding.readableOwnerActorIds).size !==
      actorBinding.readableOwnerActorIds.length
  ) {
    throw new Error("Workflow personal-context actor binding is invalid.");
  }
  const consentAuthority = personalContextConsentAuthorityV1Schema.parse(
    value.consentAuthority,
  );
  const executionScope = parsePersistedExecutionScope(value.executionScope);
  if (!executionScope) {
    throw new Error("Workflow personal-context prompt scope is invalid.");
  }
  const databaseAccessScope = parseDatabaseMemoryAccessScope(
    value.databaseAccessScope,
  );
  const expectedPromptScope = createExecutionScope({
    tenantId: consentAuthority.tenantId,
    initiatingActorId: canonicalActorId,
    executingPrincipalType: "user",
    executingPrincipalId: canonicalActorId,
    correlationId: executionScope.correlationId,
    purpose: PERSONAL_CONTEXT_RETRIEVAL_PURPOSE,
  });
  const expectedDatabaseScope = databaseMemoryAccessScopeFromExecutionScope(
    expectedPromptScope,
    {
      purposeId: MEMORY_PURPOSE_IDS.retrieve,
      auditPurpose: PERSONAL_CONTEXT_RETRIEVAL_PURPOSE,
    },
  );
  if (
    consentAuthority.tenantId !== executionScope.tenantId ||
    consentAuthority.actorId !== canonicalActorId ||
    sourceContractSha256(executionScope) !==
      sourceContractSha256(expectedPromptScope) ||
    serializeDatabaseMemoryAccessScope(databaseAccessScope) !==
      serializeDatabaseMemoryAccessScope(expectedDatabaseScope)
  ) {
    throw new Error("Workflow personal-context access envelope is invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    actorBinding,
    consentAuthority,
    executionScope,
    databaseAccessScope,
  });
}

function assertWorkflowExecutionScope(
  access: RequestPersonalContextMemoryAccessV1,
  scope: ExecutionScope,
) {
  if (
    scope.tenantId !== access.consentAuthority.tenantId ||
    !scope.initiatingActorId ||
    !access.actorBinding.readableOwnerActorIds.includes(scope.initiatingActorId) ||
    scope.correlationId !== access.executionScope.correlationId ||
    scope.delegationId !== null ||
    scope.purpose !== "workflow.run"
  ) {
    throw new Error(
      "Workflow personal context does not match its execution authority.",
    );
  }
}

function workflowExecutionScopeSha256(executionScope: ExecutionScope) {
  return sourceContractSha256({
    contract: "workflow-execution-scope-v1",
    executionScope,
  });
}
