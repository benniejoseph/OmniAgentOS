import "server-only";

import { isMoltbookToolId } from "@/lib/moltbook/contracts";
import { getAgentRunIdentityPin } from "@/lib/runs/store";
import type { AgentRunContinuation, AgentRunRecord } from "@/lib/runs/types";
import {
  canonicalRequestActorBindingFromSecurityContext,
  type CanonicalRequestActorBindingV1,
} from "@/lib/security/canonical-actor";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export function continuationAuthUserBinding(context: SecurityContext) {
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding) return undefined;
  return Object.freeze({
    version: 1 as const,
    source: context.source as "session" | "mobile",
    authUserId: binding.authUserId,
    email: context.actorId,
    canonicalActorId: binding.canonicalActorId,
  });
}

export async function resolveContinuationAuthAuthority(
  run: AgentRunRecord,
  continuation: AgentRunContinuation,
  executionScope: ExecutionScope | undefined,
): Promise<{
  securityContext: SecurityContext;
  actorBinding?: CanonicalRequestActorBindingV1;
}> {
  const requiresAuthenticatedBinding = isMoltbookToolId(
    continuation.pendingToolCall.toolId,
  ) || Boolean(
    continuation.toolPolicy?.allowedToolIds.some(isMoltbookToolId),
  );
  const binding = continuation.context.authUserBinding;
  if (!requiresAuthenticatedBinding && !binding) {
    return {
      securityContext: {
        tenantId: continuation.context.tenantId,
        actorId: continuation.context.actorId,
        role: continuation.context.role,
        source: "default",
      },
    };
  }
  const runPin = await getAgentRunIdentityPin(run.id, {
    tenantId: continuation.context.tenantId,
  });
  if (
    !binding ||
    binding.version !== 1 ||
    (binding.source !== "session" && binding.source !== "mobile") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      binding.authUserId,
    ) ||
    binding.email !== continuation.context.actorId ||
    binding.canonicalActorId !== `actor:${binding.authUserId}` ||
    !executionScope ||
    executionScope.tenantId !== continuation.context.tenantId ||
    executionScope.initiatingActorId !== binding.email ||
    executionScope.executingPrincipalType !== "agent" ||
    !runPin ||
    runPin.runId !== run.id ||
    runPin.tenantId !== executionScope.tenantId ||
    runPin.actorId !== binding.canonicalActorId ||
    runPin.logicalAgentId !== run.agentId ||
    runPin.principalId !== executionScope.executingPrincipalId ||
    run.ownerActorId !== binding.email
  ) {
    throw new Error(
      "The approved continuation lost its authenticated Agent owner binding.",
    );
  }
  return {
    securityContext: {
      tenantId: continuation.context.tenantId,
      actorId: continuation.context.actorId,
      role: continuation.context.role,
      source: "service",
    },
    actorBinding: Object.freeze({
      version: 1,
      kind: "auth_user",
      authUserId: binding.authUserId,
      canonicalActorId: binding.canonicalActorId,
      legacyOwnerActorIds: Object.freeze([binding.email]),
      readableOwnerActorIds: Object.freeze([
        binding.canonicalActorId,
        binding.email,
      ]),
    }),
  };
}
