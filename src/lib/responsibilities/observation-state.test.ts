import { describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { assertAdmittedObservationPlan, createResponsibilityObservationPipeline, responsibilityObservationEventPayload, type AdmittedResponsibilityObservation } from "./observation-state";
import { observationNow as now, observationPolicySha256 as policySha256, observationRecord as record, observationSource as source, projectionFixture as projection, sourceReadFixture } from "./observation-test-fixtures";
import type { ResponsibilityBaseline } from "./observation-contracts";
function pipeline(reader = vi.fn(async () => sourceReadFixture())) { return { reader, ...createResponsibilityObservationPipeline({ record, policySha256, readAuthoritativeSource: reader }) }; }

describe("Responsibility observation admission and baseline plans", () => {
  it("loads only the persisted selected source under exact scope and establishes an evidence-backed baseline", async () => {
    const flow = pipeline();
    const accepted = await flow.read({ observationKey: "first", observedAt: now });
    const plan = flow.plan(accepted, null, 0);
    expect(flow.reader).toHaveBeenCalledExactlyOnceWith({ source, observedAt: now, target: expect.objectContaining({ tenantId: record.tenantId, actorId: record.actorId, responsibilityId: record.id, responsibilityRevision: record.revision, reviewSha256: record.review!.reviewSha256 }) });
    expect(plan).toMatchObject({ outcome: "baseline_established", nextBaseline: { revision: 1 }, change: null, authorityEffect: "none", activationSupported: false });
    expect(JSON.stringify(plan)).not.toContain("Budget review"); expect(JSON.stringify(plan)).not.toContain("Owner prepares briefing");
    expect(plan.observation.sources[0].evidence[0].id).toBe("meeting-a:v1");
  });
  it("refuses copied/caller-authored observations and admissions from a different pipeline", async () => {
    const first = pipeline(); const other = pipeline();
    const accepted = await first.read({ observationKey: "first", observedAt: now });
    const copied = JSON.parse(JSON.stringify(accepted)) as AdmittedResponsibilityObservation;
    expect(() => first.plan(copied, null, 0)).toThrow(/could not be admitted/);
    expect(() => other.plan(accepted, null, 0)).toThrow(/could not be admitted/);
    expect(Object.isFrozen(accepted.observation.sources)).toBe(true);
    const plan = first.plan(accepted, null, 0);
    expect(() => assertAdmittedObservationPlan(plan)).not.toThrow();
    expect(() => assertAdmittedObservationPlan(JSON.parse(JSON.stringify(plan)))).toThrow(/could not be admitted/);
  });
  it.each(["missing", "stale", "partial", "unsupported", "semantic_comparison_required"] as const)("retains the prior baseline for %s evidence", async (reason) => {
    const reader = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(sourceReadFixture()).mockResolvedValueOnce({ state: "unavailable", source, reason });
    const flow = createResponsibilityObservationPipeline({ record, policySha256, readAuthoritativeSource: reader });
    const baseline = flow.plan(await flow.read({ observationKey: "first", observedAt: now }), null, 0).nextBaseline!;
    const saved = JSON.stringify(baseline);
    const plan = flow.plan(await flow.read({ observationKey: "second", observedAt: now }), baseline, 1);
    expect(plan).toMatchObject({ outcome: "insufficient_evidence", nextBaseline: null, change: null, reasons: [reason] });
    expect(JSON.stringify(baseline)).toBe(saved);
  });
  it("distinguishes denied and failed evidence from a successful no_change", async () => {
    const reader = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce({ state: "unavailable", source, reason: "access_denied" }).mockRejectedValueOnce(new Error("private provider failure"));
    const flow = createResponsibilityObservationPipeline({ record, policySha256, readAuthoritativeSource: reader });
    expect(flow.plan(await flow.read({ observationKey: "denied", observedAt: now }), null, 0).outcome).toBe("blocked");
    const failed = flow.plan(await flow.read({ observationKey: "failed", observedAt: now }), null, 0);
    expect(failed).toMatchObject({ outcome: "failed", nextBaseline: null, reasons: ["retrieval_failed"] });
    expect(JSON.stringify(failed)).not.toContain("private provider failure");
  });
  it("refuses wrong scope/source, missing citations and malformed success claims", async () => {
    const good = sourceReadFixture();
    const cases: unknown[] = [
      { ...good, authority: { ...good.authority, requestActorId: "foreign-owner" } },
      { ...good, source: { ...source, id: "unselected-meeting" } },
      { ...good, evidence: [] }, { ...good, complete: false },
      { ...good, projection: { ...projection, facts: [{ ...projection.facts[0], evidenceIds: ["invented"] }] } },
      { ...good, evidence: [good.evidence[0], good.evidence[0]] },
    ];
    for (const item of cases) {
      const flow = createResponsibilityObservationPipeline({ record, policySha256, readAuthoritativeSource: async () => item });
      const plan = flow.plan(await flow.read({ observationKey: "bad", observedAt: now }), null, 0);
      expect(plan.nextBaseline).toBeNull(); expect(plan.outcome).not.toBe("no_change");
    }
  });
  it("checks freshness independently of source content and rejects future timestamps", async () => {
    const good = sourceReadFixture();
    for (const fields of [{ freshUntil: now }, { observedAt: "2026-10-03T22:00:00.000Z", sourceUpdatedAt: "2026-10-03T21:00:00.000Z" }, { observedAt: "2026-10-04T00:01:00.000Z" }]) {
      const flow = createResponsibilityObservationPipeline({ record, policySha256, readAuthoritativeSource: async () => ({ ...good, ...fields }) });
      expect(flow.plan(await flow.read({ observationKey: "stale", observedAt: now }), null, 0)).toMatchObject({ outcome: "insufficient_evidence", reasons: ["stale"], nextBaseline: null });
    }
  });
  it("advances complete cosmetic provenance quietly while retaining an independent material-change record", async () => {
    const reader = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(sourceReadFixture())
      .mockResolvedValueOnce(sourceReadFixture({ ...projection, meeting: { ...projection.meeting!, agenda: [...projection.meeting!.agenda, "Security review"] } }))
      .mockResolvedValueOnce({ ...sourceReadFixture({ ...projection, meeting: { ...projection.meeting!, agenda: ["# Security review", "Release planning", "Budget review"] } }), revisionId: "meeting-a:v2", revisionSha256: "d".repeat(64) });
    const flow = createResponsibilityObservationPipeline({ record, policySha256, readAuthoritativeSource: reader });
    const first = flow.plan(await flow.read({ observationKey: "first", observedAt: now }), null, 0);
    const changed = flow.plan(await flow.read({ observationKey: "changed", observedAt: now }), first.nextBaseline, 1);
    expect(changed).toMatchObject({ outcome: "material_change", reasons: ["agenda"], change: { deliveryState: "not_requested" }, nextBaseline: { revision: 2 } });
    const oldChange = JSON.stringify(changed.change);
    const cosmetic = flow.plan(await flow.read({ observationKey: "cosmetic", observedAt: now }), changed.nextBaseline, 2);
    expect(cosmetic).toMatchObject({ outcome: "no_change", change: null, nextBaseline: { revision: 3 } });
    expect(JSON.stringify(changed.change)).toBe(oldChange);
    expect(responsibilityObservationEventPayload(changed)).toMatchObject({ outcome: "material_change", sourceCount: 1, evidenceCount: 1, deliveryRequested: false });
  });
  it("does not silently reset a baseline after policy/review drift and rejects stale CAS", async () => {
    const flow = pipeline(); const accepted = await flow.read({ observationKey: "first", observedAt: now });
    const baseline = flow.plan(accepted, null, 0).nextBaseline!;
    expect(() => flow.plan(accepted, baseline, 0)).toThrow(/could not be admitted/);
    for (const fields of [{ policySha256: "0".repeat(64) }, { target: { ...baseline.target, responsibilityRevision: 99 } }]) {
      const { baselineSha256: _old, ...body } = { ...baseline, ...fields }; void _old;
      const changed = { ...body, baselineSha256: canonicalJsonSha256(body) } as ResponsibilityBaseline;
      expect(() => flow.plan(accepted, changed, 1)).toThrow(/could not be admitted/);
    }
  });
  it("treats conflicting authoritative facts and unsupported semantic comparisons as uncertainty", async () => {
    for (const changed of [ { ...projection, facts: [...projection.facts, { ...projection.facts[0], value: 999 }] }, { ...projection, comparisonState: "unresolved" as const } ]) {
      const flow = createResponsibilityObservationPipeline({ record, policySha256, readAuthoritativeSource: async () => sourceReadFixture(changed) });
      expect(flow.plan(await flow.read({ observationKey: "conflict", observedAt: now }), null, 0)).toMatchObject({ outcome: "insufficient_evidence", nextBaseline: null });
    }
  });
  it("retains source-backed prose as hashes and refuses to label its substantive change no_change or material_change", async () => {
    const prose = { ...projection, uninterpretedText: [{ key: "meeting-summary", value: "Review the budget", evidenceIds: ["meeting-a:v1"] }] };
    const reader = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(sourceReadFixture(prose)).mockResolvedValueOnce(sourceReadFixture({ ...prose, uninterpretedText: [{ ...prose.uninterpretedText[0], value: "Approve the budget" }] }));
    const flow = createResponsibilityObservationPipeline({ record, policySha256, readAuthoritativeSource: reader });
    const first = flow.plan(await flow.read({ observationKey: "first", observedAt: now }), null, 0);
    const next = flow.plan(await flow.read({ observationKey: "next", observedAt: now }), first.nextBaseline, 1);
    expect(next).toMatchObject({ outcome: "insufficient_evidence", reasons: ["semantic_comparison_required"], nextBaseline: null, change: null });
  });
});
