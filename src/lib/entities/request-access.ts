import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import {
  buildEntityAccessBinding,
  ENTITY_PURPOSE_IDS,
  type EntityAccessBinding,
} from "@/lib/entities/registry";
import {
  canonicalRequestActorBindingFromSecurityContext,
  type CanonicalRequestActorBindingV1,
} from "@/lib/security/canonical-actor";
import {
  createExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export type RequestEntityAccessV1 = Readonly<{
  actorBinding: CanonicalRequestActorBindingV1;
  accessBinding: EntityAccessBinding;
  executionScope: ExecutionScope;
}>;

export function requestEntityAccessFromSecurityContext(
  context: SecurityContext,
  input: {
    purposeId: "entity.read.v1" | "entity.review.v1";
    correlationId: string;
  },
): RequestEntityAccessV1 | undefined {
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!actorBinding) return undefined;

  const accessBinding = buildEntityAccessBinding({
    tenantId: context.tenantId,
    ownerActorId: actorBinding.canonicalActorId,
    visibility: "user_private",
    sensitivity: "confidential",
    allowedPurposeIds: ENTITY_PURPOSE_IDS,
    boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
  });
  const executionScope = createExecutionScope({
    tenantId: context.tenantId,
    initiatingActorId: actorBinding.canonicalActorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorBinding.canonicalActorId,
    workspaceId: null,
    projectId: null,
    missionId: null,
    correlationId: input.correlationId,
    purpose: input.purposeId,
  });

  return Object.freeze({ actorBinding, accessBinding, executionScope });
}
