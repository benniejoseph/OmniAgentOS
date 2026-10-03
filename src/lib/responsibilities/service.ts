import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
import {
  RESPONSIBILITY_COMPATIBILITY, RESPONSIBILITY_CONTRACT, responsibilityChangeSchema, responsibilityCreateSchema, responsibilityIdSchema,
  type ResponsibilityPins, type ResponsibilityRecord,
} from "./contracts";
import { incompleteDraft, notFound, ResponsibilityError, responsibilityId, reviewPreview, type ResponsibilityOwner } from "./state";
import type { ResponsibilityStore } from "./store";

export type ResponsibilityDependencies = ResponsibilityStore & {
  pins(context: SecurityContext, owner: ResponsibilityOwner, record: ResponsibilityRecord): Promise<ResponsibilityPins>;
  now(): string;
};
const defaults: ResponsibilityDependencies = {
  list: async (...args) => (await import("./store")).listResponsibilities(...args),
  read: async (...args) => (await import("./store")).readResponsibility(...args),
  replay: async (...args) => (await import("./store")).replayResponsibility(...args),
  change: async (...args) => (await import("./store")).changeResponsibility(...args),
  pins: async (...args) => (await import("./references")).resolveResponsibilityPins(...args),
  now: () => new Date().toISOString(),
};
const envelope = () => ({ schemaVersion: 1 as const, contract: RESPONSIBILITY_CONTRACT, compatibility: RESPONSIBILITY_COMPATIBILITY });
export async function listResponsibilityDrafts(context: SecurityContext, limit = 40, dependencies = defaults) {
  const owner = authorize(context, "read");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const result = await dependencies.list(owner, limit);
  return { ...envelope(), ...result, coverage: { kind: "bounded_recent" as const, limit, returned: result.records.length, total: null } };
}
export async function getResponsibilityDraft(context: SecurityContext, id: string, review = false, dependencies = defaults) {
  const owner = authorize(context, "read");
  requireId(id);
  const record = await dependencies.read(owner, id);
  if (!record) throw notFound();
  const issues = incompleteDraft(record.draft, dependencies.now());
  if (!review) return { ...envelope(), record, readiness: { state: issues.length ? "incomplete" : "not_checked", issues } };
  // A read-only preview is available only to an account allowed to record its review.
  authorize(context, "manage.workflow");
  if (issues.length) return { ...envelope(), record, readiness: { state: "incomplete", issues } };
  try {
    const pins = await dependencies.pins(context, owner, record);
    return { ...envelope(), record, readiness: reviewPreview(record, pins) };
  } catch (error) {
    if (error instanceof ResponsibilityError && error.status === 409) return { ...envelope(), record, readiness: { state: "blocked", issues: [error.code] } };
    throw new ResponsibilityError("The selected references could not be checked. Retry the review read.", 503, "responsibility_review_unavailable");
  }
}
export async function createResponsibilityDraft(context: SecurityContext, input: unknown, key: string, dependencies = defaults) {
  const owner = authorize(context, "manage.workflow");
  const value = responsibilityCreateSchema.safeParse(input);
  if (!value.success) throw invalid();
  const id = responsibilityId(owner, key);
  const result = await dependencies.change(owner, id, value.data, key);
  return { ...envelope(), ...result };
}
export async function changeResponsibilityDraft(context: SecurityContext, id: string, input: unknown, key: string, dependencies = defaults) {
  const owner = authorize(context, "manage.workflow");
  requireId(id);
  const value = responsibilityChangeSchema.safeParse(input);
  if (!value.success) throw invalid();
  // A confirmed receipt remains replayable after source drift or expiry; it grants no execution authority.
  const replay = await dependencies.replay(owner, id, value.data, key);
  if (replay) return { ...envelope(), ...replay };
  if (value.data.action === "update") return { ...envelope(), ...await dependencies.change(owner, id, value.data, key) };
  const record = await dependencies.read(owner, id);
  if (!record) throw notFound();
  if (record.revision !== value.data.expectedRevision || record.draftSha256 !== value.data.draftSha256 || incompleteDraft(record.draft, dependencies.now()).length) {
    throw new ResponsibilityError("The exact draft is incomplete, expired, or changed. Request a new review.", 409, "responsibility_review_changed");
  }
  const preview = reviewPreview(record, await dependencies.pins(context, owner, record));
  return { ...envelope(), ...await dependencies.change(owner, id, value.data, key, preview) };
}
function authorize(context: SecurityContext, action: "read" | "manage.workflow"): ResponsibilityOwner {
  if (!canPerform(context.role, action)) throw new ResponsibilityError("This account cannot perform that responsibility action.", 403, "responsibility_forbidden");
  const canonical = canonicalAuthUserActorFromSecurityContext(context);
  if ((context.source === "session" || context.source === "mobile") && !canonical) throw new ResponsibilityError("The signed-in owner could not be bound.", 409, "responsibility_owner_unbound");
  return { tenantId: context.tenantId, actorId: canonical?.actorId ?? context.actorId };
}
function requireId(id: string) { if (!responsibilityIdSchema.safeParse(id).success) throw invalid(); }
function invalid() { return new ResponsibilityError("The responsibility request is invalid or uses an unsupported contract.", 400, "responsibility_request_invalid"); }
