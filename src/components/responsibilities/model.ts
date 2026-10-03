import type { ResponsibilityDraft, ResponsibilityMutation, ResponsibilityPins, ResponsibilityPreview, ResponsibilityRecord, ResponsibilitySource } from "@/lib/responsibilities/contracts";
import type { ResponsibilityReceipt } from "@/lib/responsibilities/state";
import type { PilotConfiguration, ResponsibilityLifecycle, ResponsibilityLifecycleRequest, ResponsibilityRuntimeReceipt, ResponsibilityWake } from "@/lib/responsibilities/runtime-contracts";
import type { ResponsibilityBaseline, ResponsibilityObservationReceipt } from "@/lib/responsibilities/observation-contracts";

// Type-only server imports keep Zod, Node crypto and storage out of this route.
export type { ResponsibilityDraft, ResponsibilityMutation, ResponsibilityPins, ResponsibilityPreview, ResponsibilityRecord, ResponsibilitySource, ResponsibilityReceipt, PilotConfiguration, ResponsibilityLifecycle, ResponsibilityLifecycleRequest, ResponsibilityRuntimeReceipt, ResponsibilityWake };
export const DRAFT_CONTRACT = "asael-responsibility-draft:1";
export const RUNTIME_CONTRACT = "asael-responsibility-runtime:1";
export const budgetDimensions = ["modelTurns", "tokens", "costMicrousd", "wallTimeMs", "toolCalls", "browserActions", "agents", "fanOut", "retries", "replans"] as const;
export const budgetLabels: Record<typeof budgetDimensions[number], string> = { modelTurns: "Model turns", tokens: "Tokens", costMicrousd: "Cost (micro USD)", wallTimeMs: "Wall time (ms)", toolCalls: "Tool calls", browserActions: "Browser actions", agents: "Agent dispatches", fanOut: "Fan out", retries: "Retries", replans: "Replans" };
export type Owner = { tenantId: string; actorId?: string };
/** The session endpoint publishes the canonical AuthUser ID. Match its current
 * email to the request actor before deriving the same owner projection used by
 * the server. This scopes client state; the API still authorizes every read. */
export function sessionResponsibilityOwner(value: unknown): Required<Owner> | undefined {
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
  if (!object(value) || value.authenticated !== true || !object(value.context) || !object(value.user) || typeof value.context.tenantId !== "string" || !value.context.tenantId ||
    typeof value.user.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.user.id) ||
    typeof value.user.email !== "string" || !value.user.email || value.context.actorId !== value.user.email) return undefined;
  return { tenantId: value.context.tenantId, actorId: `actor:${value.user.id}` };
}
export type Readiness = ResponsibilityPreview | { state: "incomplete" | "not_checked" | "blocked"; issues: string[] };
export type Detail = { record: ResponsibilityRecord; readiness: Readiness };
export type DraftResult = { current: ResponsibilityRecord; receipt: ResponsibilityReceipt; replayed: boolean };
export type RuntimeResult = { current: ResponsibilityLifecycle; receipt: ResponsibilityRuntimeReceipt; replayed: boolean };
export type RuntimeView = {
  current: ResponsibilityLifecycle | null;
  disclosure: { pilot: string; source: string; comparison: string; cadence: string; stops: string; execution: string };
  wakes: ResponsibilityWake[]; receipts: ResponsibilityRuntimeReceipt[];
  coverage: { limit: number; total: null; hasMoreWakes: boolean; hasMoreReceipts: boolean };
  dispatchReadiness: "not_observed"; deliverySupported: false;
  preview?: { state: "ready"; configuration: PilotConfiguration; authorityEffect: "none"; dispatchReadiness: "not_observed" } | { state: "blocked"; reason: string; authorityEffect: "none" };
};
export type ObservationView = {
  receipts: ResponsibilityObservationReceipt[]; baseline: ResponsibilityBaseline | null; hasMore: boolean;
  policy: { id: string; policySha256: string; adapterCoverage: string; materialExamples: readonly string[]; cosmeticExamples: readonly string[]; unsupportedExamples: readonly string[] };
  coverage: { kind: "bounded_recent"; limit: number; returned: number; total: null };
};
export type ReferenceGroup<T> = { state: "available" | "unavailable"; items: T[]; hasMore: boolean | null; errorCode?: string };
export type References = { owner: Required<Owner>; groups: {
  sources: ReferenceGroup<{ source: ResponsibilitySource; label: string }>;
  work: ReferenceGroup<NonNullable<ResponsibilityDraft["work"]> & { label: string }>;
  procedures: ReferenceGroup<{ id: string; label: string }>;
  agents: ReferenceGroup<{ id: string; label: string }>;
} };
export function emptyDraft(): ResponsibilityDraft {
  return { schemaVersion: 1, purpose: "", desiredOutcome: "", sources: [], cadence: null, limits: null, notificationRule: null,
    successCondition: "", stopConditions: [], work: null, procedureId: null, agentId: null };
}
export function finitePilotLimits(): NonNullable<ResponsibilityDraft["limits"]> {
  return { maxChecks: 7, maxNotifications: 0, cumulative: { modelTurns: 0, tokens: 0, costMicrousd: 0, wallTimeMs: 210_000, toolCalls: 7, browserActions: 0, agents: 7, fanOut: 0, retries: 0, replans: 0 } };
}
export function sourceKey(source: ResponsibilitySource) { return JSON.stringify([source.kind, source.id, "workspaceId" in source ? source.workspaceId : null]); }
export function responsibilityHref(id: string) { return `/app/responsibilities/${encodeURIComponent(id)}`; }
export function responsibilityApi(id: string) { return `/api/responsibilities/${encodeURIComponent(id)}`; }
export function readableCode(value: string) { return value.replace(/^responsibility_/, "").replaceAll("_", " "); }
export function sameJson(left: unknown, right: unknown) { return canonicalJson(left) === canonicalJson(right); }
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item !== null && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}
export function remainingBudget(lifecycle: ResponsibilityLifecycle, dimension: typeof budgetDimensions[number]) {
  return lifecycle.budget.limits[dimension] - lifecycle.budget.used[dimension] - lifecycle.budget.reserved[dimension];
}
