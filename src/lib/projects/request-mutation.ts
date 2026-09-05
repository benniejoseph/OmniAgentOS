import type { SecurityContext } from "@/lib/security/types";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { ProjectMutationContext } from "@/lib/projects/store";

export function projectMutationFromRequest(
  request: Request,
  context: SecurityContext,
  input: { purpose: string; projectId?: string },
): ProjectMutationContext {
  const suppliedIdempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (
    suppliedIdempotencyKey &&
    (
      suppliedIdempotencyKey.length > 200 ||
      !/^[A-Za-z0-9._:-]+$/.test(suppliedIdempotencyKey)
    )
  ) {
    throw new Error(
      "Idempotency-Key must be 200 characters or fewer and use letters, numbers, dot, underscore, colon, or hyphen.",
    );
  }
  const requestId = request.headers.get("x-request-id")?.trim();
  const correlationId = requestId && requestId.length <= 240
    ? requestId
    : suppliedIdempotencyKey || crypto.randomUUID();
  return {
    idempotencyKey: suppliedIdempotencyKey || correlationId,
    executionScope: executionScopeFromSecurityContext(context, {
      projectId: input.projectId,
      correlationId,
      purpose: input.purpose,
    }),
  };
}
