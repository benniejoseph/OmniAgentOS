import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
import { responsibilityIdSchema } from "./contracts";
import { responsibilityLifecycleRequestSchema } from "./runtime-contracts";
import { ResponsibilityError } from "./state";
import { controlResponsibilityRuntime, readResponsibilityRuntime } from "./lifecycle-store";

export const lifecycleDependencies = { read: readResponsibilityRuntime, control: controlResponsibilityRuntime };
export async function getResponsibilityLifecycle(context: SecurityContext, id: string, preview = false, dependencies = lifecycleDependencies) {
  const owner = authorize(context, preview ? "manage.workflow" : "read");
  requireId(id);
  return dependencies.read(owner, id, preview);
}
export async function changeResponsibilityLifecycleService(context: SecurityContext, id: string, request: unknown, key: string, dependencies = lifecycleDependencies) {
  const owner = authorize(context, "manage.workflow"); requireId(id);
  const checked = responsibilityLifecycleRequestSchema.safeParse(request);
  if (!checked.success) throw new ResponsibilityError("The exact responsibility lifecycle request is invalid.", 400, "responsibility_request_invalid");
  return dependencies.control(owner, id, checked.data, key);
}
function authorize(context: SecurityContext, action: "read" | "manage.workflow") {
  if (!canPerform(context.role, action)) throw new ResponsibilityError("This account cannot perform that responsibility action.", 403, "responsibility_forbidden");
  const canonical = canonicalAuthUserActorFromSecurityContext(context);
  // Standing authority requires a real current account. Internal tick identity
  // cannot create a new owner's activation through this public service.
  if (!canonical) throw new ResponsibilityError("An authenticated canonical owner is required.", 409, "responsibility_owner_unbound");
  return { tenantId: context.tenantId, actorId: canonical.actorId };
}
function requireId(id: string) {
  if (!responsibilityIdSchema.safeParse(id).success) throw new ResponsibilityError("The responsibility ID is invalid.", 400, "responsibility_request_invalid");
}
