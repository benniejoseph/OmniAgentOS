import {
  PromptQueueStoreError,
  type PromptQueueAuthority,
} from "@/lib/command/prompt-queue-store";
import { CommandContextResolutionError } from "@/lib/command/context-reference-runtime";
import { CommandModelSelectionError } from "@/lib/models/command-selection";
import {
  canonicalRequestActorBindingFromSecurityContext,
} from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export function promptQueueAuthority(
  context: SecurityContext,
  purpose: string,
  itemId?: string,
): PromptQueueAuthority {
  const sessionId = context.auth?.sessionId?.trim();
  if (!sessionId) {
    throw new PromptQueueStoreError(
      "conflict",
      "A current authenticated session is required for prompt queue changes.",
    );
  }
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!actorBinding) {
    throw new PromptQueueStoreError(
      "conflict",
      "A canonical authenticated account is required for prompt queue changes.",
      403,
    );
  }
  const canonicalContext: SecurityContext = {
    ...context,
    actorId: actorBinding.canonicalActorId,
  };
  return {
    tenantId: context.tenantId,
    ownerActorId: actorBinding.canonicalActorId,
    requestActorId: context.actorId,
    sessionId,
    executionScope: executionScopeFromSecurityContext(canonicalContext, {
      correlationId: `prompt-queue:${itemId || "collection"}:${crypto.randomUUID()}`,
      causationId: itemId,
      purpose,
    }),
  };
}

export function promptQueueErrorResponse(error: unknown) {
  if (error instanceof CommandContextResolutionError) {
    return Response.json({
      error: error.code,
      message: error.message,
    }, {
      status: error.status,
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (error instanceof CommandModelSelectionError) {
    return Response.json({
      error: "model_drift",
      message: error.message,
    }, {
      status: 409,
      headers: { "cache-control": "private, no-store" },
    });
  }
  if (error instanceof PromptQueueStoreError) {
    return Response.json({
      error: error.code,
      message: error.message,
    }, {
      status: error.status,
      headers: { "cache-control": "private, no-store" },
    });
  }
  throw error;
}
