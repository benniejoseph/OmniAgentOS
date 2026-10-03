import { budgetDimensions, canonicalJson, DRAFT_CONTRACT, RUNTIME_CONTRACT, sameJson, sourceKey,
  type Detail, type DraftResult, type ObservationView, type Owner, type References, type ResponsibilityDraft, type ResponsibilityLifecycle,
  type ResponsibilityLifecycleRequest, type ResponsibilityMutation, type ResponsibilityPins, type ResponsibilityRecord, type ResponsibilitySource, type RuntimeResult, type RuntimeView } from "./model";

export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exactId = (value: unknown): value is string => text(value) && value.length <= 240 && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value);
export const responsibilityId = (value: unknown): value is string => text(value) && /^responsibility:[a-f0-9]{64}$/.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const member = (value: unknown, choices: readonly string[]) => typeof value === "string" && choices.includes(value);
const version = (value: unknown, contract: string): value is Record<string, unknown> => object(value) && value.schemaVersion === 1 && value.contract === contract;
const owned = (value: Record<string, unknown>, owner: Owner) => value.tenantId === owner.tenantId && text(value.actorId) && (!owner.actorId || value.actorId === owner.actorId);
const fail = (): never => { throw new Error("The response could not be verified for this responsibility and account. Reload before continuing."); };
const counters = (value: unknown): boolean => object(value) && Object.keys(value).length === budgetDimensions.length && budgetDimensions.every((key) => integer(value[key]) && Number(value[key]) <= 1e12);
export async function sha256(value: unknown) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function source(value: unknown): value is ResponsibilitySource {
  return object(value) && exactId(value.id) && (value.kind === "meeting" ? exactId(value.workspaceId) : value.kind === "capture_asset" ||
    value.kind === "thread" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id));
}
const work = (value: unknown): boolean => object(value) && [value.workspaceId, value.projectId, value.workItemId].every(exactId);
function cadence(value: unknown) {
  if (!object(value) || !member(value.frequency, ["hourly", "daily", "weekly"]) || !integer(value.interval) || value.interval < 1 || value.interval > 24 || !text(value.timezone) || !date(value.startsAt) || !date(value.expiresAt) || value.missedPolicy !== "skip") return false;
  const duration = Date.parse(value.expiresAt) - Date.parse(value.startsAt);
  try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }); } catch { return false; }
  return duration > 0 && duration <= 366 * 86_400_000;
}
export function validDraft(value: unknown): value is ResponsibilityDraft {
  if (!object(value) || value.schemaVersion !== 1 || ![value.purpose, value.desiredOutcome, value.successCondition].every((item) => typeof item === "string") ||
    !Array.isArray(value.sources) || value.sources.length > 20 || !value.sources.every(source) || new Set(value.sources.map(sourceKey)).size !== value.sources.length ||
    !strings(value.stopConditions) || value.stopConditions.length > 8 || (value.work !== null && !work(value.work)) ||
    (value.procedureId !== null && !exactId(value.procedureId)) || (value.agentId !== null && !exactId(value.agentId)) || (value.cadence !== null && !cadence(value.cadence))) return false;
  const boundedText = (item: unknown, max: number) => typeof item === "string" && item.length <= max && item.trim() === item && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item);
  if (!boundedText(value.purpose, 2000) || !boundedText(value.desiredOutcome, 2000) || !boundedText(value.successCondition, 1000) || !value.stopConditions.every((item) => item.length > 0 && boundedText(item, 500))) return false;
  if (value.notificationRule !== null && (!object(value.notificationRule) || value.notificationRule.kind !== "material_change_only" || value.notificationRule.destination !== "owner_in_app" || value.notificationRule.quietOnNoChange !== true)) return false;
  return value.limits === null || object(value.limits) && integer(value.limits.maxChecks) && value.limits.maxChecks > 0 && value.limits.maxChecks <= 10_000 &&
    integer(value.limits.maxNotifications) && value.limits.maxNotifications <= 1000 && counters(value.limits.cumulative);
}
function pins(value: unknown): value is ResponsibilityPins {
  return object(value) && Array.isArray(value.sources) && value.sources.length > 0 && value.sources.length <= 20 &&
    value.sources.every((item) => object(item) && source(item.source) && digest(item.revisionSha256)) && work(value.work) && object(value.work) && digest(value.work.projectionSha256) &&
    object(value.procedure) && exactId(value.procedure.id) && digest(value.procedure.snapshotSha256) && digest(value.procedure.toolBindingsSha256) &&
    object(value.agent) && [value.agent.id, value.agent.definitionVersionId, value.agent.principalVersionId].every(exactId) && digest(value.agent.identityPinSha256) && digest(value.agent.policySha256);
}
async function reviewDigest(record: ResponsibilityRecord, revision: number, value: ResponsibilityPins) {
  if (!sameJson(value.sources.map((pin) => pin.source), record.draft.sources) || !sameJson({ workspaceId: value.work.workspaceId, projectId: value.work.projectId, workItemId: value.work.workItemId }, record.draft.work) ||
    value.procedure.id !== record.draft.procedureId || value.agent.id !== record.draft.agentId) return fail();
  return sha256({ contract: "responsibility-review:1", id: record.id, tenantId: record.tenantId, actorId: record.actorId,
    revision, draftSha256: record.draftSha256, pins: value, authorityEffect: "none", activationSupported: false });
}
export async function record(value: unknown, owner: Owner, id?: string): Promise<ResponsibilityRecord> {
  if (!object(value) || value.schemaVersion !== 1 || !responsibilityId(value.id) || id && value.id !== id || !owned(value, owner) || !integer(value.revision) || value.revision < 1 ||
    !member(value.state, ["draft", "reviewed"]) || !validDraft(value.draft) || !digest(value.draftSha256) || !date(value.createdAt) || !date(value.updatedAt) || value.createdAt > value.updatedAt ||
    value.draftSha256 !== await sha256({ contract: "responsibility-draft:1", draft: value.draft })) return fail();
  const result = value as unknown as ResponsibilityRecord;
  if (value.state === "draft") { if (value.review !== null) return fail(); }
  else if (!object(value.review) || value.review.schemaVersion !== 1 || !pins(value.review.pins) || value.review.authorityEffect !== "none" || value.review.activationSupported !== false ||
    value.review.draftSha256 !== value.draftSha256 || value.review.reviewedAt !== value.updatedAt || value.review.reviewSha256 !== await reviewDigest(result, result.revision - 1, value.review.pins)) return fail();
  return result;
}
function draftEnvelope(value: unknown): value is Record<string, unknown> {
  return version(value, DRAFT_CONTRACT) && object(value.compatibility) && value.compatibility.schemaVersion === 1 && value.compatibility.activationSupported === false &&
    value.compatibility.executionAuthority === "none" && value.compatibility.unknownVersionBehavior === "reject_without_mutation" &&
    sameJson(value.compatibility.supportedActions, ["create", "update", "review"]);
}
export async function readList(value: unknown, owner: Owner, limit: number) {
  if (!draftEnvelope(value) || !Array.isArray(value.records) || value.records.length > limit || typeof value.hasMore !== "boolean" || !object(value.coverage) ||
    value.coverage.kind !== "bounded_recent" || value.coverage.limit !== limit || value.coverage.returned !== value.records.length || value.coverage.total !== null) return fail();
  const records: ResponsibilityRecord[] = [];
  for (const item of value.records) records.push(await record(item, records.length ? { tenantId: owner.tenantId, actorId: records[0].actorId } : owner));
  if (new Set(records.map((item) => item.id)).size !== records.length) return fail();
  return { records, hasMore: value.hasMore };
}
export async function readDetail(value: unknown, owner: Owner, id: string): Promise<Detail> {
  if (!draftEnvelope(value) || !object(value.readiness)) return fail();
  const current = await record(value.record, owner, id); const ready = value.readiness;
  if (ready.state === "ready") {
    if (!pins(ready.pins) || ready.draftSha256 !== current.draftSha256 || ready.authorityEffect !== "none" || ready.activationSupported !== false ||
      ready.reviewSha256 !== await reviewDigest(current, current.revision, ready.pins)) return fail();
  } else if (!member(ready.state, ["incomplete", "not_checked", "blocked"]) || !strings(ready.issues)) return fail();
  return { record: current, readiness: ready as Detail["readiness"] };
}
export async function verifyDraftResult(value: unknown, owner: Owner, input: ResponsibilityMutation, key: string, id?: string): Promise<DraftResult> {
  if (!draftEnvelope(value) || !object(value.receipt) || typeof value.replayed !== "boolean") return fail();
  const receipt = value.receipt; const snapshot = await record(receipt.snapshot, owner, id);
  const keySha = await sha256(["responsibility-idempotency:1", key]);
  const exactOwner = { tenantId: snapshot.tenantId, actorId: snapshot.actorId };
  const current = await record(value.current, exactOwner, snapshot.id);
  if (receipt.schemaVersion !== 1 || receipt.idempotencySha256 !== keySha || receipt.id !== `responsibility-mutation:${await sha256([snapshot.tenantId, snapshot.actorId, keySha])}` ||
    receipt.requestSha256 !== await sha256(["responsibility-request:1", snapshot.id, input]) || receipt.expectedRevision !== input.expectedRevision || snapshot.revision !== input.expectedRevision + 1 ||
    receipt.action !== ({ create: "created", update: "updated", review: "reviewed" } as const)[input.action] || receipt.savedAt !== snapshot.updatedAt || receipt.authorityEffect !== "none" || receipt.activationSupported !== false ||
    current.revision < snapshot.revision || current.revision === snapshot.revision && !sameJson(current, snapshot) || !value.replayed && !sameJson(current, snapshot)) return fail();
  if (input.action === "create" && snapshot.id !== `responsibility:${await sha256([snapshot.tenantId, snapshot.actorId, keySha])}` ||
    input.action !== "review" && (!sameJson(input.draft, snapshot.draft) || snapshot.state !== "draft") || input.action === "review" &&
    (snapshot.review?.reviewSha256 !== input.reviewSha256 || snapshot.draftSha256 !== input.draftSha256)) return fail();
  return { current, receipt: receipt as unknown as DraftResult["receipt"], replayed: value.replayed };
}
async function configuration(value: unknown) {
  if (!object(value) || value.schemaVersion !== 1 || value.pilot !== "native_meeting_metadata_v1" || !integer(value.responsibilityRevision) || !digest(value.reviewSha256) || !digest(value.draftSha256) ||
    !pins(value.pins) || !source(value.source) || value.source.kind !== "meeting" || !object(value.tool) || value.tool.id !== "app.meetings.show" || !object(value.tool.input) ||
    value.tool.input.meetingId !== value.source.id || value.tool.input.workspaceId !== value.source.workspaceId || !digest(value.tool.contractSha256) || !cadence(value.cadence) ||
    !object(value.cadence) || value.cadence.frequency === "hourly" || !integer(value.maximumChecks) || value.maximumChecks < 1 || value.maximumChecks > 10000 ||
    !counters(value.cumulativeLimits) || !counters(value.checkReservation) || !digest(value.comparisonPolicySha256) || value.notificationAuthority !== "none" || value.approvalAuthority !== "none" || value.mutationAuthority !== "none" ||
    !sameJson(value.stops, ["expiry", "meeting_started", "meeting_canceled"])) return fail();
  const { configurationSha256, ...body } = value;
  if (configurationSha256 !== await sha256(body)) return fail();
  return value as unknown as NonNullable<RuntimeView["current"]>["configuration"];
}
async function lifecycle(value: unknown, owner: Owner, id: string): Promise<ResponsibilityLifecycle> {
  if (!version(value, RUNTIME_CONTRACT) || !owned(value, owner) || value.responsibilityId !== id || !integer(value.revision) || value.revision < 1 || !integer(value.generation) || value.generation < 1 ||
    !member(value.state, ["active", "pausing", "paused", "ending", "ended", "blocked"]) || !text(value.reason) || !date(value.activatedAt) || !date(value.updatedAt) ||
    (value.nextDueAt !== null && !date(value.nextDueAt)) || value.state !== "active" && value.nextDueAt !== null || !object(value.budget)) return fail();
  const config = await configuration(value.configuration); const budget = value.budget;
  if (!counters(budget.limits) || !counters(budget.used) || !counters(budget.reserved) || !integer(budget.maximumChecks) || !integer(budget.usedChecks) || !integer(budget.reservedChecks) ||
    budget.maximumChecks !== config.maximumChecks || !sameJson(budget.limits, config.cumulativeLimits) || budget.usedChecks + budget.reservedChecks > budget.maximumChecks) return fail();
  const result = value as unknown as ResponsibilityLifecycle;
  if (budgetDimensions.some((key) => result.budget.used[key] + result.budget.reserved[key] > result.budget.limits[key])) return fail();
  return result;
}
async function runtimeReceipt(value: unknown, owner: Owner, id: string) {
  if (!object(value) || value.schemaVersion !== 1 || !digest(value.idempotencySha256) || !digest(value.requestSha256) || !integer(value.previousRevision) || !date(value.savedAt) || !text(value.action)) return fail();
  const snapshot = await lifecycle(value.snapshot, owner, id);
  const { receiptSha256, ...body } = value;
  if (receiptSha256 !== await sha256(body) || snapshot.revision !== value.previousRevision + 1 || value.savedAt !== snapshot.updatedAt ||
    value.id !== `responsibility-runtime-receipt:${await sha256([snapshot.tenantId, snapshot.actorId, value.idempotencySha256])}`) return fail();
  return value as unknown as RuntimeResult["receipt"];
}
export async function readRuntime(value: unknown, owner: Owner, id: string): Promise<RuntimeView> {
  if (!version(value, RUNTIME_CONTRACT) || !object(value.disclosure) || !["pilot", "source", "comparison", "cadence", "stops", "execution"].every((key) => text((value.disclosure as Record<string, unknown>)[key])) ||
    value.dispatchReadiness !== "not_observed" || value.deliverySupported !== false || !Array.isArray(value.wakes) || value.wakes.length > 40 || !Array.isArray(value.receipts) || value.receipts.length > 40 ||
    !object(value.coverage) || value.coverage.limit !== 40 || value.coverage.total !== null || typeof value.coverage.hasMoreWakes !== "boolean" || typeof value.coverage.hasMoreReceipts !== "boolean") return fail();
  const current = value.current === null ? null : await lifecycle(value.current, owner, id);
  const exactOwner = current ? { tenantId: current.tenantId, actorId: current.actorId } : owner;
  for (const receipt of value.receipts) await runtimeReceipt(receipt, exactOwner, id);
  for (const wake of value.wakes) if (!object(wake) || !owned(wake, exactOwner) || wake.responsibilityId !== id || !text(wake.id) || !text(wake.state) || !date(wake.scheduledFor) || !integer(wake.generation)) return fail();
  if (value.preview !== undefined) {
    if (!object(value.preview) || value.preview.authorityEffect !== "none") return fail();
    if (value.preview.state === "ready") { await configuration(value.preview.configuration); if (value.preview.dispatchReadiness !== "not_observed") return fail(); }
    else if (value.preview.state !== "blocked" || !text(value.preview.reason)) return fail();
  }
  return value as unknown as RuntimeView;
}
export async function verifyRuntimeResult(value: unknown, owner: Owner, id: string, input: ResponsibilityLifecycleRequest, key: string): Promise<RuntimeResult> {
  if (!version(value, RUNTIME_CONTRACT) || typeof value.replayed !== "boolean") return fail();
  const receipt = await runtimeReceipt(value.receipt, owner, id); const snapshot = receipt.snapshot;
  const current = await lifecycle(value.current, { tenantId: snapshot.tenantId, actorId: snapshot.actorId }, id);
  if (receipt.action !== input.action || receipt.previousRevision !== input.expectedRevision || snapshot.generation !== input.expectedGeneration + 1 ||
    receipt.idempotencySha256 !== await sha256(["responsibility-idempotency:1", key]) || receipt.requestSha256 !== await sha256({ responsibilityId: id, ...input }) ||
    current.revision < snapshot.revision || current.revision === snapshot.revision && !sameJson(current, snapshot) || !value.replayed && !sameJson(current, snapshot) ||
    "configurationSha256" in input && snapshot.configuration.configurationSha256 !== input.configurationSha256 ||
    input.action === "activate" && snapshot.state !== "active" || input.action === "resume" && snapshot.state !== "active" ||
    input.action === "pause" && !["paused", "pausing"].includes(snapshot.state) || input.action === "end" && !["ended", "ending"].includes(snapshot.state)) return fail();
  return { current, receipt, replayed: value.replayed };
}
export async function readObservations(value: unknown, owner: Owner, id: string): Promise<ObservationView> {
  if (!version(value, "asael-responsibility-observation:1") || value.authorityEffect !== "none" || value.deliverySupported !== false || !object(value.policy) || !text(value.policy.id) || !digest(value.policy.policySha256) || !text(value.policy.adapterCoverage) ||
    ![value.policy.materialExamples, value.policy.cosmeticExamples, value.policy.unsupportedExamples].every(strings) || !Array.isArray(value.receipts) || value.receipts.length > 100 || typeof value.hasMore !== "boolean" ||
    !object(value.coverage) || value.coverage.returned !== value.receipts.length || value.coverage.kind !== "bounded_recent" || !integer(value.coverage.limit) || value.coverage.total !== null) return fail();
  const { policySha256, ...policyBody } = value.policy;
  if (policySha256 !== await sha256(policyBody)) return fail();
  for (const receipt of value.receipts) {
    if (!object(receipt) || receipt.schemaVersion !== 1 || !object(receipt.plan) || !object(receipt.plan.observation) || !object(receipt.plan.observation.target) || !owned(receipt.plan.observation.target, owner) ||
      receipt.plan.observation.target.responsibilityId !== id || !text(receipt.plan.observation.state) || !date(receipt.plan.observation.observedAt) || !strings(receipt.plan.reasons) || !strings(receipt.plan.observation.failureReasons) ||
      !member(receipt.plan.outcome, ["baseline_established", "material_change", "no_change", "insufficient_evidence", "blocked", "failed"]) || !Array.isArray(receipt.plan.observation.sources)) return fail();
    for (const item of receipt.plan.observation.sources) if (!object(item) || !source(item.source) || !text(item.state) || !Array.isArray(item.evidence) || !item.evidence.every((evidence) => object(evidence) && text(evidence.id) && text(evidence.kind))) return fail();
    if (receipt.plan.change !== null && (!object(receipt.plan.change) || receipt.plan.change.deliveryState !== "not_requested" || !strings(receipt.plan.change.categories))) return fail();
    const { receiptSha256, ...body } = receipt;
    if (receiptSha256 !== await sha256(body)) return fail();
  }
  if (value.baseline !== null && (!object(value.baseline) || !object(value.baseline.target) || !owned(value.baseline.target, owner) || value.baseline.target.responsibilityId !== id ||
    !integer(value.baseline.revision) || !date(value.baseline.acceptedAt) || !digest(value.baseline.baselineSha256))) return fail();
  if (object(value.baseline)) { const { baselineSha256, ...body } = value.baseline; if (baselineSha256 !== await sha256(body)) return fail(); }
  return value as unknown as ObservationView;
}
export function readReferences(value: unknown, owner: Owner): References {
  if (!version(value, "asael-responsibility-references:1") || !object(value.owner) || !owned(value.owner, owner) || !object(value.groups) ||
    value.authorityEffect !== "none" || !object(value.coverage) || value.coverage.perGroupLimit !== 40 || value.coverage.totals !== "unavailable") return fail();
  for (const key of ["sources", "work", "procedures", "agents"] as const) {
    const group = value.groups[key];
    if (!object(group) || !member(group.state, ["available", "unavailable"]) || !Array.isArray(group.items) || group.items.length > 40 ||
      (group.state === "available" ? typeof group.hasMore !== "boolean" : group.hasMore !== null || group.items.length !== 0)) return fail();
    for (const item of group.items) if (!object(item) || typeof item.label !== "string" || (key === "sources" ? !source(item.source) : key === "work" ? !work(item) : !exactId(item.id))) return fail();
  }
  return value as unknown as References;
}
export class ResponseError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function requestJson(path: string, signal: AbortSignal, input?: { method: "POST" | "PATCH"; key: string; body: unknown }) {
  const response = await fetch(path, { signal, cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json", ...(input ? { "Content-Type": "application/json", "Idempotency-Key": input.key } : {}) },
    ...(input ? { method: input.method, body: JSON.stringify(input.body) } : {}) });
  const value: unknown = await response.json();
  if (!response.ok) throw new ResponseError(object(value) && text(value.error) ? value.error : `Request returned ${response.status}.`, response.status);
  return value;
}
