import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { RESPONSIBILITY_COMPATIBILITY } from "@/lib/responsibilities/contracts";
import { prepareResponsibilityChange, responsibilityId, reviewPreview } from "@/lib/responsibilities/state";
import { draftFixture as draft, nowFixture as now, ownerFixture as owner, pinsFixture as pins } from "@/lib/responsibilities/test-fixtures";
import { buildRuntimeReceipt, changeResponsibilityLifecycle } from "@/lib/responsibilities/lifecycle-state";
import { runtimeHead, runtimeId, runtimeNow, runtimeOwner } from "@/lib/responsibilities/runtime-test-fixtures";
import { readDetail, readList, readObservations, readReferences, sha256, validDraft, verifyDraftResult, verifyRuntimeResult } from "./client";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "@/lib/responsibilities/comparison-policy";
import { createResponsibilityObservationPipeline } from "@/lib/responsibilities/observation-state";
import { observationRecord, observationNow, observationPolicySha256, observationOwner, sourceReadFixture } from "@/lib/responsibilities/observation-test-fixtures";
import { DRAFT_CONTRACT, RUNTIME_CONTRACT } from "./model";

const key = "client-create"; const id = responsibilityId(owner, key);
const input = { action: "create" as const, expectedRevision: 0 as const, draft };
const create = () => prepareResponsibilityChange({ owner, id, key, now, mutation: input });
const envelope = (value: object) => ({ schemaVersion: 1, contract: DRAFT_CONTRACT, compatibility: RESPONSIBILITY_COMPATIBILITY, ...value });

describe("Responsibility browser contracts without server runtime imports", () => {
  it("matches server canonical hashes including reordered keys and Unicode", async () => {
    const body = { z: [{ title: "Café <script>untrusted()</script>", a: 1 }], a: "line\nnext", nested: { z: null, a: true } };
    expect(await sha256(body)).toBe(canonicalJsonSha256(body));
  });
  it("accepts the exact receipt and rejects wrong owner, tenant, key, CAS, action and changed input", async () => {
    const result = envelope(create());
    expect(await verifyDraftResult(result, owner, input, key)).toMatchObject({ current: { id, revision: 1 }, replayed: false });
    for (const attempt of [
      () => verifyDraftResult(result, { ...owner, actorId: "actor:other" }, input, key),
      () => verifyDraftResult(result, { ...owner, tenantId: "other" }, input, key),
      () => verifyDraftResult(result, owner, input, "wrong-key"),
      () => verifyDraftResult(result, owner, { action: "update", expectedRevision: 1, draft }, key, id),
      () => verifyDraftResult(result, owner, { ...input, draft: { ...draft, purpose: "changed" } }, key),
    ]) await expect(attempt()).rejects.toThrow(/verified/);
  });
  it("keeps an old immutable replay receipt separate from a newer verified head", async () => {
    const first = create();
    const next = prepareResponsibilityChange({ owner, id, key: "update", now, current: first.current, mutation: { action: "update", expectedRevision: 1, draft: { ...draft, purpose: "New purpose" } } });
    const replay = envelope({ current: next.current, receipt: first.receipt, replayed: true });
    expect(await verifyDraftResult(replay, owner, input, key)).toMatchObject({ current: { revision: 2 }, receipt: { snapshot: { revision: 1 } } });
    await expect(verifyDraftResult({ ...replay, replayed: false }, owner, input, key)).rejects.toThrow();
  });
  it("verifies exact draft and review pins and refuses broadened compatibility or unknown versions", async () => {
    const first = create(); const readiness = reviewPreview(first.current, pins); const response = envelope({ record: first.current, readiness });
    expect((await readDetail(response, owner, id)).readiness.state).toBe("ready");
    for (const bad of [
      { ...response, schemaVersion: 2 },
      { ...response, compatibility: { ...RESPONSIBILITY_COMPATIBILITY, activationSupported: true } },
      { ...response, record: { ...first.current, draft: { ...draft, purpose: "tampered" } } },
      { ...response, readiness: { ...readiness, pins: { ...pins, sources: [{ ...pins.sources[0], revisionSha256: "0".repeat(64) }] } } },
    ]) await expect(readDetail(bad, owner, id)).rejects.toThrow();
  });
  it("rejects duplicate, foreign and over-limit list records", async () => {
    const current = create().current;
    const response = (records: unknown[]) => envelope({ records, hasMore: false, coverage: { kind: "bounded_recent", limit: 40, returned: records.length, total: null } });
    expect((await readList(response([current]), owner, 40)).records).toHaveLength(1);
    await expect(readList(response([current, current]), owner, 40)).rejects.toThrow();
    await expect(readList(response([{ ...current, actorId: "other" }]), owner, 40)).rejects.toThrow();
    await expect(readList(response(Array(41).fill(current)), owner, 40)).rejects.toThrow();
  });
  it("requires every finite budget dimension, meaningful cadence and unique sources", () => {
    expect(validDraft(draft)).toBe(true);
    for (const bad of [ { ...draft, sources: [draft.sources[0], draft.sources[0]] },
      { ...draft, limits: { ...draft.limits, cumulative: { tokens: 42 } } },
      { ...draft, limits: { ...draft.limits, maxChecks: Infinity } },
      { ...draft, cadence: { ...draft.cadence, expiresAt: null } },
      { ...draft, cadence: { ...draft.cadence, timezone: "bad/zone" } },
    ]) expect(validDraft(bad)).toBe(false);
  });
  it("distinguishes empty authorized references from unavailable and rejects foreign picker metadata", () => {
    const empty = { state: "available", items: [], hasMore: false };
    const value = { schemaVersion: 1, contract: "asael-responsibility-references:1", owner,
      authorityEffect: "none", coverage: { perGroupLimit: 40, totals: "unavailable" },
      groups: { sources: empty, work: empty, procedures: { state: "unavailable", items: [], hasMore: null, errorCode: "responsibility_reference_read_unavailable" }, agents: empty } };
    expect(readReferences(value, owner).groups.procedures.state).toBe("unavailable");
    expect(() => readReferences({ ...value, owner: { ...owner, actorId: "foreign" } }, owner)).toThrow();
    expect(() => readReferences({ ...value, groups: { ...value.groups, sources: { state: "unavailable", items: [{ source: draft.sources[0], label: "leaked" }], hasMore: null } } }, owner)).toThrow();
  });
  it("correlates lifecycle receipts to the exact generation, configuration and idempotency request", async () => {
    const request = { action: "pause" as const, expectedRevision: runtimeHead.revision, expectedGeneration: runtimeHead.generation };
    const current = changeResponsibilityLifecycle({ owner: runtimeOwner, responsibilityId: runtimeId, current: runtimeHead, request, now: runtimeNow });
    const receipt = buildRuntimeReceipt({ current, previousRevision: runtimeHead.revision, key: "pause", request: { responsibilityId: runtimeId, ...request }, action: "pause" });
    const response = { schemaVersion: 1, contract: RUNTIME_CONTRACT, current, receipt, replayed: false };
    expect(await verifyRuntimeResult(response, runtimeOwner, runtimeId, request, "pause")).toMatchObject({ current: { state: "paused" } });
    await expect(verifyRuntimeResult(response, runtimeOwner, runtimeId, { ...request, expectedGeneration: 0 }, "pause")).rejects.toThrow();
    await expect(verifyRuntimeResult(response, runtimeOwner, runtimeId, request, "different-key")).rejects.toThrow();
    await expect(verifyRuntimeResult({ ...response, current: { ...current, budget: { ...current.budget, usedChecks: 99999 } } }, runtimeOwner, runtimeId, request, "pause")).rejects.toThrow();
  });
  it("verifies accepted baseline and observation evidence independently of no-change delivery", async () => {
    const flow = createResponsibilityObservationPipeline({ record: observationRecord, policySha256: observationPolicySha256, readAuthoritativeSource: async () => sourceReadFixture() });
    const first = flow.plan(await flow.read({ observationKey: "baseline", observedAt: observationNow }), null, 0);
    const plan = flow.plan(await flow.read({ observationKey: "quiet", observedAt: observationNow }), first.nextBaseline, 1);
    const request = { responsibilityId: observationRecord.id, expectedResponsibilityRevision: observationRecord.revision, expectedReviewSha256: observationRecord.review!.reviewSha256, expectedBaselineRevision: 1, policySha256: observationPolicySha256 };
    const receiptBody = { schemaVersion: 1, request, requestSha256: canonicalJsonSha256({ owner: observationOwner, request }), plan, savedAt: observationNow };
    const response = { schemaVersion: 1, contract: "asael-responsibility-observation:1", policy: RESPONSIBILITY_MEETING_COMPARISON_POLICY, authorityEffect: "none", deliverySupported: false,
      receipts: [{ ...receiptBody, receiptSha256: canonicalJsonSha256(receiptBody) }], baseline: plan.nextBaseline, hasMore: false, coverage: { kind: "bounded_recent", limit: 25, returned: 1, total: null } };
    expect(await readObservations(response, observationOwner, observationRecord.id)).toMatchObject({ receipts: [{ plan: { outcome: "no_change", change: null } }], baseline: { revision: 2 } });
    await expect(readObservations({ ...response, deliverySupported: true }, observationOwner, observationRecord.id)).rejects.toThrow();
    await expect(readObservations({ ...response, policy: { ...response.policy, materialExamples: ["Invented comparison authority"] } }, observationOwner, observationRecord.id)).rejects.toThrow();
    await expect(readObservations(response, { ...observationOwner, actorId: "foreign" }, observationRecord.id)).rejects.toThrow();
  });
});
