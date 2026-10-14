import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { comparisonDigests } from "./comparison-policy";
import { buildBaselineRebind, verifyBaselineRebind } from "./baseline-rebind";
import { buildRuntimeReceipt, changeResponsibilityLifecycle, verifyPilotConfiguration } from "./lifecycle-state";
import { projectionFixture } from "./observation-test-fixtures";
import { runtimeConfiguration, runtimeHead, runtimeId, runtimeOwner } from "./runtime-test-fixtures";
import type { PilotConfiguration, ResponsibilityLifecycle } from "./runtime-contracts";

const blockedAt = "2026-10-04T00:01:00.000Z", reviewedAt = "2026-10-04T00:02:00.000Z", now = "2026-10-04T00:03:00.000Z", nextDueAt = "2026-10-05T00:00:00.000Z";
const blocked: ResponsibilityLifecycle = { ...runtimeHead, revision: 2, generation: 2, state: "blocked", reason: "authority_changed", nextDueAt: null, updatedAt: blockedAt };
function config(edit: (body: Omit<PilotConfiguration, "configurationSha256">) => void = () => {}) {
  const { configurationSha256: _hash, ...body } = structuredClone(runtimeConfiguration); void _hash;
  body.responsibilityRevision += 1; body.reviewSha256 = "4".repeat(64); body.tool.contractSha256 = "5".repeat(64);
  body.pins.procedure.toolBindingsSha256 = "6".repeat(64); body.pins.sources[0].revisionSha256 = "7".repeat(64); edit(body);
  return verifyPilotConfiguration({ ...body, configurationSha256: canonicalJsonSha256(body) });
}
function recover(configuration = config(), current = blocked, reviewTime = reviewedAt) {
  return changeResponsibilityLifecycle({ owner: runtimeOwner, responsibilityId: runtimeId, current, configuration, reviewedAt: reviewTime, now, nextDueAt,
    request: { action: "resume", expectedRevision: current.revision, expectedGeneration: current.generation, configurationSha256: configuration.configurationSha256, acknowledgePilot: configuration.pilot } });
}
describe("Reviewed recovery preserves standing bounds and evidence", () => {
  it("repins an authority-blocked record without replacing its identity, budgets or activation", () => {
    const current = recover();
    expect(current).toMatchObject({ responsibilityId: blocked.responsibilityId, revision: 3, generation: 3, state: "active", reason: "owner_resumed", nextDueAt, activatedAt: blocked.activatedAt });
    expect(current.budget).toEqual(blocked.budget); expect(current.configuration).toEqual(config());
  });
  it.each(["source_unavailable", "uncertain_started_work", "budget_exhausted"] as const)("cannot recover a %s block", (reason) => {
    expect(() => recover(config(), { ...blocked, reason })).toThrow();
  });
  it("requires a review after the block with a newer exact target, no reservations and an unexpired next cadence", () => {
    for (const time of [undefined, blockedAt, "2026-10-03T00:00:00.000Z"]) {
      expect(() => changeResponsibilityLifecycle({ owner: runtimeOwner, responsibilityId: runtimeId, current: blocked, configuration: config(), reviewedAt: time, now, nextDueAt,
        request: { action: "resume", expectedRevision: 2, expectedGeneration: 2, configurationSha256: config().configurationSha256, acknowledgePilot: config().pilot } })).toThrow();
    }
    for (const changed of [config((body) => { body.responsibilityRevision = runtimeConfiguration.responsibilityRevision; }), config((body) => { body.reviewSha256 = runtimeConfiguration.reviewSha256; })]) expect(() => recover(changed)).toThrow();
    expect(() => recover(config(), { ...blocked, state: "paused" })).toThrow();
    expect(() => recover(config(), { ...blocked, budget: { ...blocked.budget, reservedChecks: 1, reserved: runtimeConfiguration.checkReservation } })).toThrow();
    expect(() => recover(config(), { ...blocked, budget: { ...blocked.budget, reserved: runtimeConfiguration.checkReservation } })).toThrow();
    expect(() => recover(config(), blocked, "2026-10-06T00:00:00.000Z")).toThrow();
  });
  it.each([
    ["draft", (body: Omit<PilotConfiguration, "configurationSha256">) => { body.draftSha256 = "a".repeat(64); }],
    ["cadence", (body: Omit<PilotConfiguration, "configurationSha256">) => { body.cadence.interval = 2; }],
    ["expiry", (body: Omit<PilotConfiguration, "configurationSha256">) => { body.cadence.expiresAt = "2026-10-12T00:00:00.000Z"; }],
    ["check limit", (body: Omit<PilotConfiguration, "configurationSha256">) => { body.maximumChecks += 1; }],
    ["budget", (body: Omit<PilotConfiguration, "configurationSha256">) => { body.cumulativeLimits.toolCalls += 1; }],
    ["agent", (body: Omit<PilotConfiguration, "configurationSha256">) => { body.pins.agent.id = "other-agent"; }],
    ["procedure", (body: Omit<PilotConfiguration, "configurationSha256">) => { body.pins.procedure.id = "other-procedure"; }],
    ["work", (body: Omit<PilotConfiguration, "configurationSha256">) => { body.pins.work.workItemId = "other-work"; }],
    ["comparison", (body: Omit<PilotConfiguration, "configurationSha256">) => { body.comparisonPolicySha256 = "f".repeat(64); }],
  ])("rejects a new %s under the old responsibility", (_label, edit) => expect(() => recover(config(edit))).toThrow());
  it("rebases only the review target while preserving the exact accepted observation and rejects counterfeit evidence", () => {
    const current = recover(); const runtime = buildRuntimeReceipt({ key: "reviewed-recovery", request: { action: "resume" }, action: "resume", previousRevision: blocked.revision, current });
    const body = { schemaVersion: 1 as const, revision: 1, target: { ...runtimeOwner, responsibilityId: runtimeId, responsibilityRevision: blocked.configuration.responsibilityRevision, reviewSha256: blocked.configuration.reviewSha256 },
      policySha256: runtimeConfiguration.comparisonPolicySha256, observationId: `responsibility-observation:${"a".repeat(64)}`, observationSha256: "b".repeat(64), semantic: comparisonDigests([projectionFixture]), acceptedAt: runtimeHead.activatedAt };
    const baseline = { ...body, baselineSha256: canonicalJsonSha256(body) };
    const receipt = buildBaselineRebind(baseline, blocked, runtime);
    expect(receipt.previous).toEqual(baseline);
    expect(receipt.next).toMatchObject({ revision: 2, observationId: baseline.observationId, observationSha256: baseline.observationSha256, semantic: baseline.semantic, acceptedAt: baseline.acceptedAt,
      target: { responsibilityRevision: current.configuration.responsibilityRevision, reviewSha256: current.configuration.reviewSha256 } });
    expect(verifyBaselineRebind(receipt)).toEqual(receipt);
    const { receiptSha256: _receiptHash, ...forged } = structuredClone(receipt); void _receiptHash;
    const { baselineSha256: _baselineHash, ...nextBody } = forged.next; void _baselineHash;
    nextBody.acceptedAt = now; forged.next = { ...nextBody, baselineSha256: canonicalJsonSha256(nextBody) };
    expect(() => verifyBaselineRebind({ ...forged, receiptSha256: canonicalJsonSha256(forged) })).toThrow();
    expect(() => buildBaselineRebind({ ...baseline, target: { ...baseline.target, responsibilityId: `responsibility:${"c".repeat(64)}` } }, blocked, runtime)).toThrow();
  });
});
