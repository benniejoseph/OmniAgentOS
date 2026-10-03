import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
import { responsibilityIdSchema } from "./contracts";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "./comparison-policy";
import { RESPONSIBILITY_OBSERVATION_CONTRACT, responsibilityObservationRequestSchema } from "./observation-contracts";
import type { ResponsibilityObservationStore, TransactionalObservationReader } from "./observation-store";
import { ResponsibilityError, type ResponsibilityOwner } from "./state";

export type ResponsibilityObservationDependencies = ResponsibilityObservationStore & {
  reader(context: SecurityContext, owner: ResponsibilityOwner): TransactionalObservationReader;
  now(): string;
};
const defaults: ResponsibilityObservationDependencies = {
  history: async (...args) => (await import("./observation-store")).readResponsibilityObservationHistory(...args),
  observe: async (...args) => (await import("./observation-store")).recordResponsibilityObservation(...args),
  reader: (context, owner) => async (input, sql) => (await import("./observation-references")).responsibilityObservationReader(context, owner)(input, sql),
  now: () => new Date().toISOString(),
};
const envelope = () => ({ schemaVersion: 1 as const, contract: RESPONSIBILITY_OBSERVATION_CONTRACT, policy: RESPONSIBILITY_MEETING_COMPARISON_POLICY,
  authorityEffect: "none" as const, activationSupported: false as const, deliverySupported: false as const });

export async function getResponsibilityObservations(context: SecurityContext, id: string, limit = 25, dependencies = defaults) {
  const owner = authorize(context, "read");
  if (!responsibilityIdSchema.safeParse(id).success || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const result = await dependencies.history(owner, id, limit);
  return { ...envelope(), ...result, coverage: { kind: "bounded_recent" as const, limit, returned: result.receipts.length, total: null } };
}

/** Internal server entry point, deliberately not exposed as an HTTP mutation.
 * 6.3 must add governed runtime/generation/budget admission before any wake can
 * call this. A reviewed draft and this observation receipt never activate it.
 */
export async function observeResponsibility(context: SecurityContext, input: unknown, key: string, dependencies = defaults) {
  const owner = authorize(context, "manage.workflow");
  const checked = responsibilityObservationRequestSchema.safeParse(input);
  if (!checked.success) throw invalid();
  const frozenContext = { ...context, ...(context.auth ? { auth: { ...context.auth } } : {}) };
  return { ...envelope(), ...await dependencies.observe(owner, checked.data, key, dependencies.reader(frozenContext, owner), dependencies.now()) };
}
function authorize(context: SecurityContext, action: "read" | "manage.workflow"): ResponsibilityOwner {
  if (!canPerform(context.role, action)) throw new ResponsibilityError("This account cannot perform that responsibility action.", 403, "responsibility_forbidden");
  const canonical = canonicalAuthUserActorFromSecurityContext(context);
  if ((context.source === "session" || context.source === "mobile") && !canonical) throw new ResponsibilityError("The signed-in owner could not be bound.", 409, "responsibility_owner_unbound");
  return { tenantId: context.tenantId, actorId: canonical?.actorId ?? context.actorId };
}
function invalid() { return new ResponsibilityError("The responsibility observation request is invalid or unsupported.", 400, "responsibility_observation_request_invalid"); }
