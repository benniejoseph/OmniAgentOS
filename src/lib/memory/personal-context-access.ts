import {
  databaseMemoryAccessScopeFromExecutionScope,
  parseDatabaseMemoryAccessScope,
  serializeDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  personalContextConsentAuthorityV1Schema,
  type PersonalContextConsentAuthorityV1,
} from "@/lib/memory/personal-context-consent";
import { requireActivePersonalContextConsent } from "@/lib/memory/personal-context-consent-store";
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

export const PERSONAL_CONTEXT_RETRIEVAL_PURPOSE =
  "agent.context.personal.retrieve" as const;

export type RequestPersonalContextMemoryAccessV1 = Readonly<{
  schemaVersion: 1;
  actorBinding: CanonicalRequestActorBindingV1;
  executionScope: ExecutionScope;
  databaseAccessScope: DatabaseMemoryAccessScope;
  consentAuthority: PersonalContextConsentAuthorityV1;
}>;

export function personalContextMemoryAccessFromSecurityContext(
  context: SecurityContext,
  input: {
    correlationId: string;
    consentAuthority: PersonalContextConsentAuthorityV1;
  },
): RequestPersonalContextMemoryAccessV1 | undefined {
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!actorBinding) return undefined;
  const consentAuthority = personalContextConsentAuthorityV1Schema.parse(
    input.consentAuthority,
  );
  if (
    consentAuthority.tenantId !== context.tenantId ||
    consentAuthority.actorId !== actorBinding.canonicalActorId
  ) {
    throw new Error("Personal-context consent authority does not match the request.");
  }
  const executionScope = createExecutionScope({
    tenantId: context.tenantId,
    initiatingActorId: actorBinding.canonicalActorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorBinding.canonicalActorId,
    correlationId: input.correlationId,
    purpose: PERSONAL_CONTEXT_RETRIEVAL_PURPOSE,
  });
  return Object.freeze({
    schemaVersion: 1,
    actorBinding,
    executionScope,
    databaseAccessScope: databaseMemoryAccessScopeFromExecutionScope(
      executionScope,
      {
        purposeId: MEMORY_PURPOSE_IDS.retrieve,
        auditPurpose: PERSONAL_CONTEXT_RETRIEVAL_PURPOSE,
      },
    ),
    consentAuthority,
  });
}

export async function resolvePersonalContextMemoryAccess(
  value: RequestPersonalContextMemoryAccessV1 | undefined,
  input: {
    agentExecutionScope: ExecutionScope;
    memoryMode: "session" | "project" | "all";
  },
): Promise<DatabaseMemoryAccessScope | undefined> {
  if (!value) return undefined;
  const fail = () => {
    throw new Error("Automatic personal-memory prompt access is invalid.");
  };
  const promptScope = parsePersistedExecutionScope(value.executionScope);
  const agentScope = parsePersistedExecutionScope(input.agentExecutionScope);
  let databaseScope: DatabaseMemoryAccessScope;
  let consentAuthority: PersonalContextConsentAuthorityV1;
  try {
    databaseScope = parseDatabaseMemoryAccessScope(value.databaseAccessScope);
    consentAuthority = personalContextConsentAuthorityV1Schema.parse(
      value.consentAuthority,
    );
  } catch {
    return fail();
  }
  if (!promptScope || !agentScope || value.schemaVersion !== 1) return fail();

  const actorBinding = value.actorBinding;
  const canonicalActorId = `actor:${actorBinding.authUserId}`;
  const expectedDatabaseScope = databaseMemoryAccessScopeFromExecutionScope(
    promptScope,
    {
      purposeId: MEMORY_PURPOSE_IDS.retrieve,
      auditPurpose: PERSONAL_CONTEXT_RETRIEVAL_PURPOSE,
    },
  );
  if (
    input.memoryMode !== "all" ||
    actorBinding.version !== 1 ||
    actorBinding.kind !== "auth_user" ||
    actorBinding.canonicalActorId !== canonicalActorId ||
    actorBinding.readableOwnerActorIds[0] !== canonicalActorId ||
    new Set(actorBinding.readableOwnerActorIds).size !==
      actorBinding.readableOwnerActorIds.length ||
    agentScope.executingPrincipalType !== "agent" ||
    !agentScope.executingPrincipalId ||
    agentScope.tenantId !== promptScope.tenantId ||
    !agentScope.initiatingActorId ||
    !actorBinding.readableOwnerActorIds.includes(
      agentScope.initiatingActorId,
    ) ||
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
    promptScope.purpose !== PERSONAL_CONTEXT_RETRIEVAL_PURPOSE ||
    serializeDatabaseMemoryAccessScope(databaseScope) !==
      serializeDatabaseMemoryAccessScope(expectedDatabaseScope) ||
    consentAuthority.tenantId !== promptScope.tenantId ||
    consentAuthority.actorId !== canonicalActorId
  ) {
    return fail();
  }

  await requireActivePersonalContextConsent({
    tenantId: promptScope.tenantId,
    actorBinding,
    expectedAuthoritySha256: consentAuthority.authoritySha256,
  });
  return databaseScope;
}
