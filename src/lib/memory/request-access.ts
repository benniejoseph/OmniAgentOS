import {
  databaseMemoryAccessScopeFromExecutionScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import {
  canonicalRequestActorBindingFromSecurityContext,
  type CanonicalRequestActorBindingV1,
} from "@/lib/security/canonical-actor";
import {
  createExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export type RequestMemoryAccessV1 = Readonly<{
  actorBinding: CanonicalRequestActorBindingV1;
  executionScope: ExecutionScope;
  databaseAccessScope: DatabaseMemoryAccessScope;
}>;

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
