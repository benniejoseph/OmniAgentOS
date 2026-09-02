import type { SecurityContext } from "@/lib/security/types";

export const EXECUTION_SCOPE_VERSION = 1 as const;

export type ExecutionPrincipalType = "user" | "agent" | "system";

export type ExecutionScope = Readonly<{
  version: typeof EXECUTION_SCOPE_VERSION;
  tenantId: string;
  initiatingActorId: string | null;
  executingPrincipalType: ExecutionPrincipalType;
  executingPrincipalId: string | null;
  workspaceId: string | null;
  projectId: string | null;
  missionId: string | null;
  delegationId: string | null;
  correlationId: string;
  causationId: string | null;
  contextGrantIds: readonly string[];
  capabilityGrantIds: readonly string[];
  purpose: string;
}>;

export type CreateExecutionScopeInput = {
  tenantId: string;
  initiatingActorId: string | null;
  executingPrincipalType: ExecutionPrincipalType;
  executingPrincipalId: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  missionId?: string | null;
  delegationId?: string | null;
  correlationId: string;
  causationId?: string | null;
  contextGrantIds?: readonly string[];
  capabilityGrantIds?: readonly string[];
  purpose: string;
};

export type SecurityContextExecutionScopeInput = {
  executingPrincipalType?: ExecutionPrincipalType;
  executingPrincipalId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  missionId?: string | null;
  delegationId?: string | null;
  correlationId: string;
  causationId?: string | null;
  contextGrantIds?: readonly string[];
  capabilityGrantIds?: readonly string[];
  purpose: string;
};

/**
 * Creates the immutable scope carried by one execution boundary.
 *
 * Nullable ownership fields stay nullable intentionally. Compatibility code
 * must not invent an actor, project, mission, or delegation to make an
 * unscoped legacy call look authoritative.
 */
export function createExecutionScope(
  input: CreateExecutionScopeInput,
): ExecutionScope {
  return Object.freeze({
    version: EXECUTION_SCOPE_VERSION,
    tenantId: requiredValue(input.tenantId, "tenantId"),
    initiatingActorId: optionalValue(input.initiatingActorId),
    executingPrincipalType: input.executingPrincipalType,
    executingPrincipalId: optionalValue(input.executingPrincipalId),
    workspaceId: optionalValue(input.workspaceId),
    projectId: optionalValue(input.projectId),
    missionId: optionalValue(input.missionId),
    delegationId: optionalValue(input.delegationId),
    correlationId: requiredValue(input.correlationId, "correlationId"),
    causationId: optionalValue(input.causationId),
    contextGrantIds: normalizedIds(input.contextGrantIds),
    capabilityGrantIds: normalizedIds(input.capabilityGrantIds),
    purpose: requiredValue(input.purpose, "purpose", 500),
  });
}

/**
 * Adapts an authenticated request context without broadening its authority.
 * Agent and system callers must name their executing principal explicitly;
 * only a user execution inherits the authenticated actor ID.
 */
export function executionScopeFromSecurityContext(
  context: SecurityContext,
  input: SecurityContextExecutionScopeInput,
): ExecutionScope {
  const executingPrincipalType = input.executingPrincipalType || "user";
  const executingPrincipalId = input.executingPrincipalId !== undefined
    ? input.executingPrincipalId
    : executingPrincipalType === "user"
      ? context.actorId
      : null;

  return createExecutionScope({
    tenantId: context.tenantId,
    initiatingActorId: context.actorId || null,
    executingPrincipalType,
    executingPrincipalId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    missionId: input.missionId,
    delegationId: input.delegationId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    contextGrantIds: input.contextGrantIds,
    capabilityGrantIds: input.capabilityGrantIds,
    purpose: input.purpose,
  });
}

function normalizedIds(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze(
    [...new Set((values || []).map((value) => optionalValue(value)).filter(isString))]
      .slice(0, 256),
  );
}

function requiredValue(value: string, field: string, maxLength = 256): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Execution scope requires ${field}.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`Execution scope ${field} exceeds ${maxLength} characters.`);
  }
  return normalized;
}

function optionalValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (normalized && normalized.length > 256) {
    throw new Error("Execution scope identifier exceeds 256 characters.");
  }
  return normalized || null;
}

function isString(value: string | null): value is string {
  return typeof value === "string";
}
