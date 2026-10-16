import { z } from "zod";
import { JsonBodyError } from "@/lib/http/body";
import { forbiddenResponse } from "@/lib/security/guard";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { AvailabilityWatchError } from "./contracts";

export const watchHeaders = { "cache-control": "private, no-store" };
export const watchStopRequestSchema = z.object({ expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
export function watchOwner(context: SecurityContext) {
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding) throw new AvailabilityWatchError("Sign in with your workspace account to manage watches.", 403, "availability_watch_owner_required");
  return { tenantId: context.tenantId, actorId: binding.canonicalActorId };
}
export function watchQuery(request: Request, allowed: readonly string[] = []) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) {
    throw new AvailabilityWatchError("The watch query is invalid.");
  }
  return params;
}
export function watchDenial(error: unknown) {
  const response = forbiddenResponse(error); response.headers.set("cache-control", "private, no-store"); return response;
}
export function watchFailure(error: unknown) {
  if (error instanceof AvailabilityWatchError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: watchHeaders });
  if (error instanceof JsonBodyError || error instanceof z.ZodError) return Response.json({
    error: error instanceof z.ZodError ? "The watch request is invalid." : error.message,
    code: "availability_watch_invalid",
  }, { status: error instanceof JsonBodyError ? error.status : 400, headers: watchHeaders });
  return Response.json({ error: "Watches are temporarily unavailable. Retry the same request to recover its result.", code: "availability_watch_unavailable" }, { status: 503, headers: watchHeaders });
}
