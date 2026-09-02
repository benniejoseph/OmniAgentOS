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

export type DerivedExecutionScopeInput = {
  executingPrincipalType?: ExecutionPrincipalType;
  executingPrincipalId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  missionId?: string | null;
  delegationId?: string | null;
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

/** Derives child attribution while preserving root tenant, actor, and intent. */
export function deriveExecutionScope(
  parent: ExecutionScope,
  input: DerivedExecutionScopeInput,
): ExecutionScope {
  const contextGrantIds = narrowedGrantIds(
    parent.contextGrantIds,
    input.contextGrantIds,
    "context",
  );
  const capabilityGrantIds = narrowedGrantIds(
    parent.capabilityGrantIds,
    input.capabilityGrantIds,
    "capability",
  );
  return createExecutionScope({
    tenantId: parent.tenantId,
    initiatingActorId: parent.initiatingActorId,
    executingPrincipalType:
      input.executingPrincipalType || parent.executingPrincipalType,
    executingPrincipalId:
      input.executingPrincipalId === undefined
        ? parent.executingPrincipalId
        : input.executingPrincipalId,
    workspaceId: input.workspaceId === undefined
      ? parent.workspaceId
      : input.workspaceId,
    projectId: input.projectId === undefined ? parent.projectId : input.projectId,
    missionId: input.missionId === undefined ? parent.missionId : input.missionId,
    delegationId: input.delegationId === undefined
      ? parent.delegationId
      : input.delegationId,
    correlationId: parent.correlationId,
    causationId: input.causationId === undefined
      ? parent.causationId
      : input.causationId,
    contextGrantIds,
    capabilityGrantIds,
    purpose: input.purpose,
  });
}

export function parsePersistedExecutionScope(
  value: unknown,
): ExecutionScope | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted execution scope is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== EXECUTION_SCOPE_VERSION ||
    typeof candidate.tenantId !== "string" ||
    !isNullableString(candidate.initiatingActorId) ||
    !isExecutionPrincipalType(candidate.executingPrincipalType) ||
    !isNullableString(candidate.executingPrincipalId) ||
    !isNullableString(candidate.workspaceId) ||
    !isNullableString(candidate.projectId) ||
    !isNullableString(candidate.missionId) ||
    !isNullableString(candidate.delegationId) ||
    typeof candidate.correlationId !== "string" ||
    !isNullableString(candidate.causationId) ||
    !isStringArray(candidate.contextGrantIds) ||
    !isStringArray(candidate.capabilityGrantIds) ||
    typeof candidate.purpose !== "string"
  ) {
    throw new Error("Persisted execution scope is invalid.");
  }

  try {
    return createExecutionScope({
      tenantId: candidate.tenantId,
      initiatingActorId: candidate.initiatingActorId,
      executingPrincipalType: candidate.executingPrincipalType,
      executingPrincipalId: candidate.executingPrincipalId,
      workspaceId: candidate.workspaceId,
      projectId: candidate.projectId,
      missionId: candidate.missionId,
      delegationId: candidate.delegationId,
      correlationId: candidate.correlationId,
      causationId: candidate.causationId,
      contextGrantIds: candidate.contextGrantIds,
      capabilityGrantIds: candidate.capabilityGrantIds,
      purpose: candidate.purpose,
    });
  } catch {
    throw new Error("Persisted execution scope is invalid.");
  }
}

export function assertExecutionScopeTenant(
  scope: ExecutionScope,
  tenantId: string,
): void {
  if (scope.tenantId !== tenantId.trim()) {
    throw new Error("Execution scope tenant does not match the authorized tenant.");
  }
}

export function executionScopesEqual(
  left: ExecutionScope,
  right: ExecutionScope,
): boolean {
  return left.version === right.version &&
    left.tenantId === right.tenantId &&
    left.initiatingActorId === right.initiatingActorId &&
    left.executingPrincipalType === right.executingPrincipalType &&
    left.executingPrincipalId === right.executingPrincipalId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.missionId === right.missionId &&
    left.delegationId === right.delegationId &&
    left.correlationId === right.correlationId &&
    left.causationId === right.causationId &&
    equalIds(left.contextGrantIds, right.contextGrantIds) &&
    equalIds(left.capabilityGrantIds, right.capabilityGrantIds) &&
    left.purpose === right.purpose;
}

function normalizedIds(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze(
    [...new Set((values || []).map((value) => optionalValue(value)).filter(isString))]
      .slice(0, 256),
  );
}

function narrowedGrantIds(
  parentIds: readonly string[],
  requestedIds: readonly string[] | undefined,
  kind: "context" | "capability",
): readonly string[] {
  if (requestedIds === undefined) {
    return parentIds;
  }
  const parentSet = new Set(parentIds);
  if (requestedIds.some((id) => !parentSet.has(id))) {
    throw new Error(`Derived execution scope cannot broaden ${kind} grants.`);
  }
  return requestedIds;
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
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

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isExecutionPrincipalType(value: unknown): value is ExecutionPrincipalType {
  return value === "user" || value === "agent" || value === "system";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= 256 &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length;
}
