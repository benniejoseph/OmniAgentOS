import {
  PromptQueueStoreError,
  type PromptQueueAuthority,
} from "@/lib/command/prompt-queue-store";
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
  return {
    tenantId: context.tenantId,
    actorId: context.actorId,
    sessionId,
    executionScope: executionScopeFromSecurityContext(context, {
      correlationId: `prompt-queue:${itemId || "collection"}:${crypto.randomUUID()}`,
      causationId: itemId,
      purpose,
    }),
  };
}

export function promptQueueErrorResponse(error: unknown) {
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
