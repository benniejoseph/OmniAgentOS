import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { instantSchema, sourceKey, type ResponsibilityRecord, type ResponsibilitySource } from "./contracts";
import { changedComparisonCategories, comparisonDigests, RESPONSIBILITY_MEETING_COMPARISON_POLICY, type ComparisonProjection } from "./comparison-policy";
import {
  authoritativeSourceReadSchema, observationTargetSchema, RESPONSIBILITY_OBSERVATION_CONTRACT,
  responsibilityBaselineSchema, responsibilityChangeRecordSchema, responsibilityObservationSchema,
  type ObservationCommitPlan, type ObservationTarget, type ResponsibilityBaseline, type ResponsibilityObservation,
} from "./observation-contracts";
import { idempotencySha256, ResponsibilityError, verifiedRecord } from "./state";

const policy = RESPONSIBILITY_MEETING_COMPARISON_POLICY;
const commitPlans = new WeakSet<object>();
declare const admissionBrand: unique symbol;
export type AdmittedResponsibilityObservation = { readonly observation: ResponsibilityObservation; readonly [admissionBrand]: true };

/** Implement ONLY in a server adapter using current authorized source stores.
 * A source's own JSON/hash or an Agent report is not evidence of authorization.
 * The reader must resolve immutable IDs, verify scope/currentness/content, and
 * derive deterministic fields from that stored evidence before returning them.
 */
export type AuthoritativeResponsibilityReader = (input: {
  target: ObservationTarget; source: ResponsibilitySource; observedAt: string;
}) => Promise<unknown>;

/** This factory accepts a server-owned adapter, never client-submitted facts.
 * Only this instance's authoritative reads issue admissible values; callers
 * cannot deserialize or copy a JSON observation to advance a baseline.
 */
export function createResponsibilityObservationPipeline(input: {
  record: ResponsibilityRecord; policySha256: string; readAuthoritativeSource: AuthoritativeResponsibilityReader;
}) {
  const record = verifiedRecord(input.record);
  if (record.state !== "reviewed" || !record.review || !record.draft.cadence || input.policySha256 !== policy.policySha256) throw conflict("responsibility_observation_not_reviewed");
  const target = observationTargetSchema.parse({ tenantId: record.tenantId, actorId: record.actorId, responsibilityId: record.id,
    responsibilityRevision: record.revision, reviewSha256: record.review.reviewSha256 });
  const admissions = new WeakSet<object>();
  const sources = record.draft.sources;

  async function read(input: { observationKey: string; observedAt: string }): Promise<AdmittedResponsibilityObservation> {
    const observedAt = instantSchema.parse(input.observedAt);
    if (Date.parse(observedAt) < Date.parse(record.review!.reviewedAt) || Date.parse(observedAt) >= Date.parse(record.draft.cadence!.expiresAt)) throw conflict("responsibility_observation_expired");
    const observationKeySha256 = idempotencySha256(input.observationKey);
    const receipts: ResponsibilityObservation["sources"] = [];
    const projections: ComparisonProjection[] = [];
    for (const source of sources) {
      let raw: unknown;
      try { raw = await inputReader(source, observedAt); }
      catch { receipts.push(unavailable(source, "retrieval_failed")); continue; }
      const checked = authoritativeSourceReadSchema.safeParse(raw);
      if (!checked.success || sourceKey(checked.data.source) !== sourceKey(source)) { receipts.push(unavailable(source, "evidence_invalid")); continue; }
      const value = checked.data;
      if (value.state === "unavailable") { receipts.push(unavailable(source, value.reason)); continue; }
      if (value.authority.tenantId !== target.tenantId || value.authority.requestActorId !== target.actorId) { receipts.push(unavailable(source, "access_denied")); continue; }
      const clock = Date.parse(observedAt);
      if (Date.parse(value.observedAt) > clock || Date.parse(value.sourceUpdatedAt) > Date.parse(value.observedAt) || Date.parse(value.freshUntil) <= clock ||
        clock - Date.parse(value.observedAt) > policy.maximumSourceAgeSeconds * 1_000) { receipts.push(unavailable(source, "stale")); continue; }
      const evidence = new Map(value.evidence.map((item) => [item.id, item]));
      const cited = [...(value.projection.meeting?.evidenceIds ?? []), ...value.projection.facts.flatMap((item) => item.evidenceIds), ...value.projection.commitments.flatMap((item) => item.evidenceIds), ...value.projection.uninterpretedText.flatMap((item) => item.evidenceIds)];
      if (evidence.size !== value.evidence.length || !cited.length || cited.some((id) => !evidence.has(id))) { receipts.push(unavailable(source, "evidence_invalid")); continue; }
      if (value.projection.comparisonState !== "deterministic") { receipts.push(unavailable(source, "semantic_comparison_required")); continue; }
      projections.push(value.projection);
      receipts.push({ source, state: "accepted", reason: null, revisionId: value.revisionId, revisionSha256: value.revisionSha256,
        authoritySha256: value.authority.authoritySha256, observedAt: value.observedAt, sourceUpdatedAt: value.sourceUpdatedAt, freshUntil: value.freshUntil, evidence: value.evidence });
    }
    const failureReasons = [...new Set(receipts.flatMap((receipt) => receipt.reason ? [receipt.reason] : []))];
    let semantic: ResponsibilityObservation["semantic"] = null;
    if (!failureReasons.length) {
      try { semantic = comparisonDigests(projections); }
      catch { failureReasons.push("evidence_conflict"); }
    }
    const state: ResponsibilityObservation["state"] = failureReasons.includes("access_denied") ? "blocked"
      : failureReasons.includes("retrieval_failed") ? "failed" : failureReasons.length ? "insufficient_evidence" : "complete";
    const body = { schemaVersion: 1 as const, contract: RESPONSIBILITY_OBSERVATION_CONTRACT,
      id: `responsibility-observation:${canonicalJsonSha256([target, observationKeySha256])}`, target, policySha256: policy.policySha256,
      observationKeySha256, observedAt, sources: receipts, state, semantic, failureReasons,
      authorityEffect: "none" as const, activationSupported: false as const };
    const observation = responsibilityObservationSchema.parse({ ...body, observationSha256: canonicalJsonSha256(body) });
    const admitted = deepFreeze({ observation }) as AdmittedResponsibilityObservation;
    admissions.add(admitted);
    return admitted;
  }
  async function inputReader(source: ResponsibilitySource, observedAt: string) { return input.readAuthoritativeSource({ target: { ...target }, source: { ...source }, observedAt }); }

  function plan(admitted: AdmittedResponsibilityObservation, current: ResponsibilityBaseline | null, expectedBaselineRevision: number): ObservationCommitPlan {
    if (!admitted || !admissions.has(admitted)) throw conflict("responsibility_evidence_not_admitted");
    const observation = admitted.observation;
    const baseline = current ? verifiedBaseline(current) : null;
    if (!Number.isSafeInteger(expectedBaselineRevision) || expectedBaselineRevision < 0 || expectedBaselineRevision >= Number.MAX_SAFE_INTEGER || (baseline?.revision ?? 0) !== expectedBaselineRevision) throw conflict("responsibility_baseline_revision_conflict");
    if (baseline && (canonicalJsonSha256(baseline.target) !== canonicalJsonSha256(target) || baseline.policySha256 !== policy.policySha256)) throw conflict("responsibility_baseline_transition_required");
    const unchanged = (outcome: ObservationCommitPlan["outcome"], reasons: readonly string[]): ObservationCommitPlan => admitPlan({
      expectedBaselineRevision, observation, outcome, reasons, nextBaseline: null, change: null, authorityEffect: "none", activationSupported: false,
    });
    if (baseline && Date.parse(observation.observedAt) < Date.parse(baseline.acceptedAt)) return unchanged("insufficient_evidence", ["observation_outdated"]);
    if (observation.state !== "complete" || !observation.semantic) return unchanged(observation.state === "complete" ? "insufficient_evidence" : observation.state, observation.failureReasons);
    if (baseline && baseline.semantic.uninterpretedText !== observation.semantic.uninterpretedText) return unchanged("insufficient_evidence", ["semantic_comparison_required"]);
    const categories = baseline ? changedComparisonCategories(baseline.semantic, observation.semantic) : [];
    const nextBody = { schemaVersion: 1 as const, revision: expectedBaselineRevision + 1, target, policySha256: policy.policySha256,
      observationId: observation.id, observationSha256: observation.observationSha256, semantic: observation.semantic, acceptedAt: observation.observedAt };
    const nextBaseline = responsibilityBaselineSchema.parse({ ...nextBody, baselineSha256: canonicalJsonSha256(nextBody) });
    let change: ObservationCommitPlan["change"] = null;
    if (baseline && categories.length) {
      const changeBody = { schemaVersion: 1 as const, id: `responsibility-change:${canonicalJsonSha256([target, policy.policySha256, baseline.baselineSha256, observation.semantic.semanticSha256])}`,
        target, policySha256: policy.policySha256, previousBaselineSha256: baseline.baselineSha256, observationId: observation.id,
        categories, evidence: observation.sources.flatMap((source) => source.evidence),
        previousSemanticSha256: baseline.semantic.semanticSha256, semanticSha256: observation.semantic.semanticSha256, deliveryState: "not_requested" as const };
      change = responsibilityChangeRecordSchema.parse({ ...changeBody, changeSha256: canonicalJsonSha256(changeBody) });
    }
    return admitPlan({ expectedBaselineRevision, observation, outcome: !baseline ? "baseline_established" : change ? "material_change" : "no_change",
      reasons: !baseline ? ["first_complete_observation"] : change ? categories : ["equivalent_evidence"],
      nextBaseline, change, authorityEffect: "none", activationSupported: false } satisfies ObservationCommitPlan);
  }
  return Object.freeze({ read, plan });
}

export function assertAdmittedObservationPlan(value: ObservationCommitPlan) {
  if (!value || !commitPlans.has(value)) throw conflict("responsibility_observation_plan_not_admitted");
}
function admitPlan(value: ObservationCommitPlan) { const frozen = deepFreeze(value); commitPlans.add(frozen); return frozen; }

/** Metadata-only event plan. A future writer must commit this with CAS and the
 * immutable observation/change rows, without replacing outstanding changes. */
export function responsibilityObservationEventPayload(plan: ObservationCommitPlan) {
  return { schemaVersion: 1, responsibilityId: plan.observation.target.responsibilityId, responsibilityRevision: plan.observation.target.responsibilityRevision,
    observationId: plan.observation.id, observationSha256: plan.observation.observationSha256, policySha256: plan.observation.policySha256,
    outcome: plan.outcome, sourceCount: plan.observation.sources.length, evidenceCount: plan.observation.sources.reduce((sum, source) => sum + source.evidence.length, 0),
    previousBaselineRevision: plan.expectedBaselineRevision, nextBaselineRevision: plan.nextBaseline?.revision ?? null,
    baselineSha256: plan.nextBaseline?.baselineSha256 ?? null, changeId: plan.change?.id ?? null, changeSha256: plan.change?.changeSha256 ?? null,
    authorityEffect: "none", activationSupported: false, deliveryRequested: false };
}
function verifiedBaseline(value: unknown) {
  const parsed = responsibilityBaselineSchema.parse(value);
  const { baselineSha256, ...body } = parsed;
  const { semanticSha256, ...categories } = parsed.semantic;
  if (baselineSha256 !== canonicalJsonSha256(body) || semanticSha256 !== canonicalJsonSha256(categories)) throw conflict("responsibility_baseline_invalid");
  return parsed;
}
function unavailable(source: ResponsibilitySource, reason: NonNullable<ResponsibilityObservation["sources"][number]["reason"]>): ResponsibilityObservation["sources"][number] {
  return { source, state: "unavailable", reason, revisionId: null, revisionSha256: null, authoritySha256: null, observedAt: null, sourceUpdatedAt: null, freshUntil: null, evidence: [] };
}
function conflict(code: string) { return new ResponsibilityError("Responsibility observation evidence or baseline could not be admitted.", 409, code); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
