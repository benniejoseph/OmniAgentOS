import { randomUUID } from "node:crypto";
import {
  executionScopeFromSecurityContext,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

/** Builds capture attribution only after the route has authenticated the request. */
export function captureExecutionScopeFromSecurityContext(
  context: SecurityContext,
  request: Request,
  purpose: string,
  options: { correlationId?: string } = {},
): ExecutionScope {
  return executionScopeFromSecurityContext(context, {
    correlationId:
      normalizeCorrelationId(options.correlationId) ||
      captureRequestCorrelationId(request),
    purpose,
  });
}

function captureRequestCorrelationId(request: Request) {
  const supplied =
    request.headers.get("x-omni-correlation-id") ||
    request.headers.get("x-vercel-id");
  const normalized = normalizeCorrelationId(supplied);
  return normalized || `capture:${randomUUID()}`;
}

function normalizeCorrelationId(value?: string | null) {
  return value
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 240) || undefined;
}
