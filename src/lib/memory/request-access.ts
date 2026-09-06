import {
  databaseMemoryAccessScopeFromExecutionScope,
  parseDatabaseMemoryAccessScope,
  serializeDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  canonicalRequestActorBindingFromSecurityContext,
  type CanonicalRequestActorBindingV1,
} from "@/lib/security/canonical-actor";
import {
  createExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export type RequestMemoryAccessV1 = Readonly<{
  actorBinding: CanonicalRequestActorBindingV1;
  executionScope: ExecutionScope;
  databaseAccessScope: DatabaseMemoryAccessScope;
}>;

const AGENT_PROMPT_MEMORY_PURPOSE = "agent.context.retrieve";

/**
 * Adapts an already-authorized session/mobile request to the narrow
 * canonical-user memory canary. Unsupported service/header contexts remain on
 * the version-0 compatibility path rather than receiving invented ownership.
 */
export function requestMemoryAccessFromSecurityContext(
  context: SecurityContext,
  input: {
    purposeId: string;
    auditPurpose: string;
    correlationId: string;
  },
): RequestMemoryAccessV1 | undefined {
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!actorBinding) return undefined;

  const executionScope = createExecutionScope({
    tenantId: context.tenantId,
    initiatingActorId: actorBinding.canonicalActorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorBinding.canonicalActorId,
    workspaceId: null,
    projectId: null,
    missionId: null,
    correlationId: input.correlationId,
    purpose: input.auditPurpose,
  });
  const databaseAccessScope = databaseMemoryAccessScopeFromExecutionScope(
    executionScope,
    {
      purposeId: input.purposeId,
      auditPurpose: input.auditPurpose,
    },
  );
  return Object.freeze({
    actorBinding,
    executionScope,
    databaseAccessScope,
  });
}

/**
 * Creates the user-principal side of an explicit context selection. The
 * resulting scope is not a standing agent grant: it may be consumed only by
 * the matching request-bound prompt compiler after the caller selected at
 * least one canonical evidence ID.
 */
export function agentPromptMemoryAccessFromSecurityContext(
  context: SecurityContext,
  input: { correlationId: string },
): RequestMemoryAccessV1 | undefined {
  return requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.retrieve,
    auditPurpose: AGENT_PROMPT_MEMORY_PURPOSE,
    correlationId: input.correlationId,
  });
}

/**
 * Validates the narrow handoff from an authenticated user selection to the
 * owning direct agent run. It deliberately rejects ambient/automatic use,
 * non-personal memory modes, background principals, and unrelated actors.
 */
export function resolveAgentPromptMemoryAccess(
  value: RequestMemoryAccessV1 | undefined,
  input: {
    agentExecutionScope: ExecutionScope;
    explicitEvidenceCount: number;
    memoryMode: "session" | "project" | "all";
  },
): DatabaseMemoryAccessScope | undefined {
  if (!value) return undefined;
  const fail = () => {
    throw new Error("Explicit private-memory prompt access is invalid.");
  };
  if (
    input.explicitEvidenceCount < 1 ||
    input.explicitEvidenceCount > 24 ||
    input.memoryMode !== "all"
  ) {
    return fail();
  }

  const promptScope = parsePersistedExecutionScope(value.executionScope);
  if (!promptScope) return fail();
  const databaseScope = parseDatabaseMemoryAccessScope(
    value.databaseAccessScope,
  );
  const expectedDatabaseScope = databaseMemoryAccessScopeFromExecutionScope(
    promptScope,
    {
      purposeId: MEMORY_PURPOSE_IDS.retrieve,
      auditPurpose: AGENT_PROMPT_MEMORY_PURPOSE,
    },
  );
  const actorBinding = value.actorBinding;
  const canonicalActorId = `actor:${actorBinding.authUserId}`;
  const readableActorIds = actorBinding.readableOwnerActorIds;
  const legacyActorIds = actorBinding.legacyOwnerActorIds;
  const agentScope = input.agentExecutionScope;
  const uniqueReadableActorIds = new Set(readableActorIds);

  if (
    actorBinding.version !== 1 ||
    actorBinding.kind !== "auth_user" ||
    actorBinding.canonicalActorId !== canonicalActorId ||
    readableActorIds[0] !== canonicalActorId ||
    uniqueReadableActorIds.size !== readableActorIds.length ||
    legacyActorIds.length < 1 ||
    legacyActorIds.some((actorId) =>
      actorId === canonicalActorId || !readableActorIds.includes(actorId)
    ) ||
    agentScope.executingPrincipalType !== "agent" ||
    !agentScope.executingPrincipalId ||
    agentScope.tenantId !== promptScope.tenantId ||
    !agentScope.initiatingActorId ||
    !readableActorIds.includes(agentScope.initiatingActorId) ||
    agentScope.correlationId !== promptScope.correlationId ||
    promptScope.initiatingActorId !== canonicalActorId ||
    promptScope.executingPrincipalType !== "user" ||
    promptScope.executingPrincipalId !== canonicalActorId ||
    promptScope.workspaceId !== null ||
    promptScope.projectId !== null ||
    promptScope.missionId !== null ||
    promptScope.delegationId !== null ||
    promptScope.contextGrantIds.length !== 0 ||
    promptScope.capabilityGrantIds.length !== 0 ||
    promptScope.purpose !== AGENT_PROMPT_MEMORY_PURPOSE ||
    serializeDatabaseMemoryAccessScope(databaseScope) !==
      serializeDatabaseMemoryAccessScope(expectedDatabaseScope)
  ) {
    return fail();
  }
  return databaseScope;
}
