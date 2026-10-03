import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { createResponsibilityObservationPipeline } from "./observation-state";
import { observationNow as now, observationPolicySha256, observationRecord as record, projectionFixture, sourceReadFixture } from "./observation-test-fixtures";
import { runtimeHead } from "./runtime-test-fixtures";
import { verifyPilotConfiguration } from "./lifecycle-state";
import { admitNotificationCandidate, buildNotificationConfiguration, buildNotificationReceipt, enableNotificationAdmission, notificationCandidateId,
  notificationLifecycleTarget, transitionNotificationCandidate, verifyNotificationAdmission, verifyNotificationCandidate, verifyNotificationReceipt } from "./notification-state";

const source = record.draft.sources[0];
if (source.kind !== "meeting") throw new Error("Expected Meeting fixture");
const { configurationSha256: oldHash, ...configBody } = runtimeHead.configuration; void oldHash;
const body = { ...configBody, responsibilityRevision: record.revision, reviewSha256: record.review!.reviewSha256, draftSha256: record.draftSha256,
  pins: record.review!.pins, source, tool: { ...configBody.tool, input: { workspaceId: source.workspaceId, meetingId: source.id } } };
const runtime = { ...runtimeHead, responsibilityId: record.id, configuration: verifyPilotConfiguration({ ...body, configurationSha256: canonicalJsonSha256(body) }) };
const configuration = buildNotificationConfiguration(record, runtime, now);
const request = { action: "enable", expectedRuntimeRevision: runtime.revision, expectedRuntimeGeneration: runtime.generation,
  configurationSha256: configuration.configurationSha256, acknowledgeDestination: "owner_in_app" };
const enabled = () => enableNotificationAdmission(configuration, runtime, request, now);
async function changes() {
  let projection = projectionFixture;
  const flow = createResponsibilityObservationPipeline({ record, policySha256: observationPolicySha256, readAuthoritativeSource: async () => sourceReadFixture(projection) });
  const baseline = flow.plan(await flow.read({ observationKey: "A", observedAt: now }), null, 0);
  projection = { ...projection, meeting: { ...projection.meeting!, startsAt: "2026-10-05T10:00:00.000Z" } };
  const changed = flow.plan(await flow.read({ observationKey: "B", observedAt: now }), baseline.nextBaseline, 1);
  const equal = flow.plan(await flow.read({ observationKey: "B-again", observedAt: now }), changed.nextBaseline, 2);
  projection = projectionFixture;
  const reversed = flow.plan(await flow.read({ observationKey: "A-again", observedAt: now }), equal.nextBaseline, 3);
  return { baseline, changed, equal, reversed };
}
const fresh = "2026-10-04T01:00:00.000Z";

describe("Explicit Responsibility in-app notification authority", () => {
  it("requires a separate exact admission and leaves the runtime's none authority unchanged", () => {
    expect(enabled()).toMatchObject({ state: "enabled", used: 0, reserved: 0, configuration: { destination: "owner_in_app", maximumNotifications: 3 } });
    expect(runtime.configuration.notificationAuthority).toBe("none");
    for (const bad of [{ ...request, configurationSha256: "f".repeat(64) }, { ...request, expectedRuntimeRevision: 99 }, { ...request, expectedRuntimeGeneration: 99 }]) {
      expect(() => enableNotificationAdmission(configuration, runtime, bad, now)).toThrow();
    }
    expect(() => buildNotificationConfiguration({ ...record, draft: { ...record.draft, limits: { ...record.draft.limits!, maxNotifications: 0 } } }, runtime, now)).toThrow();
  });
  it("preserves immutable candidates while a new no-change baseline advances and distinguishes a reversion", async () => {
    const { baseline, changed, equal, reversed } = await changes();
    expect(baseline.change).toBeNull(); expect(equal.change).toBeNull();
    const pending = admitNotificationCandidate(enabled(), changed.change!, fresh, now);
    expect(pending.current).toMatchObject({ used: 0, reserved: 1 });
    expect(notificationCandidateId(pending.candidate)).toBe(pending.candidate.id);
    const later = admitNotificationCandidate(pending.current, reversed.change!, fresh, now);
    expect(later.candidate.id).not.toBe(pending.candidate.id);
    expect(pending.candidate).toMatchObject({ state: "pending", changeId: changed.change!.id, changeSha256: changed.change!.changeSha256 });
    expect(JSON.stringify(pending.candidate)).not.toContain("Budget review");
  });
  it("records a blocked candidate at the cumulative limit without over-reserving", async () => {
    const { changed } = await changes();
    const full = verifyNotificationAdmission({ ...enabled(), used: 3 });
    const result = admitNotificationCandidate(full, changed.change!, fresh, now);
    expect(result.current).toMatchObject({ used: 3, reserved: 0 });
    expect(result.candidate).toMatchObject({ state: "blocked", reason: "notification_limit", nextAttemptAt: null });
  });
  it("holds quiet candidates with the same identity and records delivery only with an exact ledger binding", async () => {
    const { changed } = await changes(); const admitted = admitNotificationCandidate(enabled(), changed.change!, fresh, now);
    const held = transitionNotificationCandidate(admitted.current, admitted.candidate, { outcome: "hold", reason: "quiet_hours", now });
    expect(held.candidate).toMatchObject({ id: admitted.candidate.id, state: "held", nextAttemptAt: "2026-10-04T00:15:00.000Z" });
    expect(held.current).toMatchObject({ used: 0, reserved: 1 });
    expect(() => transitionNotificationCandidate(held.current, held.candidate, { outcome: "deliver", reason: "in_app_recorded", now })).toThrow();
    const delivered = transitionNotificationCandidate(held.current, held.candidate, { outcome: "deliver", reason: "in_app_recorded", now,
      delivery: { notificationId: `notification_${"a".repeat(48)}`, dispositionId: `notification_disposition_${"b".repeat(48)}`, deliveryBindingSha256: "c".repeat(64) } });
    expect(delivered.current).toMatchObject({ used: 1, reserved: 0 });
    expect(delivered.candidate).toMatchObject({ state: "delivered", nextAttemptAt: null });
    expect(() => transitionNotificationCandidate(delivered.current, delivered.candidate, { outcome: "deliver", reason: "in_app_recorded", now })).toThrow();
  });
  it("bounds retries and expiry without replenishing notification budget", async () => {
    const { changed } = await changes(); const admitted = admitNotificationCandidate(enabled(), changed.change!, fresh, now);
    const result = transitionNotificationCandidate(admitted.current, admitted.candidate, { outcome: "retry", reason: "delivery_retry", now: fresh });
    expect(result.candidate).toMatchObject({ state: "expired", reason: "expired", notificationId: null });
    expect(result.current).toMatchObject({ used: 0, reserved: 0 });
    expect(() => admitNotificationCandidate(enabled(), changed.change!, now, now)).toThrow();
  });
  it("allows finite drain after check exhaustion but fences explicit pause/end and expiry", () => {
    expect(notificationLifecycleTarget(enabled(), { ...runtime, state: "ended", reason: "budget_exhausted" }, now)).toEqual({ state: "draining", reason: "checks_exhausted", cancelReason: null });
    expect(notificationLifecycleTarget(enabled(), { ...runtime, state: "paused", reason: "owner_paused" }, now).cancelReason).toBe("owner_paused");
    expect(notificationLifecycleTarget(enabled(), { ...runtime, state: "ended", reason: "owner_ended" }, now).cancelReason).toBe("owner_ended");
    expect(notificationLifecycleTarget(enabled(), runtime, configuration.expiresAt).cancelReason).toBe("expired");
  });
  it("refuses a stale delivery generation, foreign change or altered change digest", async () => {
    const { changed } = await changes(); const admitted = admitNotificationCandidate(enabled(), changed.change!, fresh, now);
    expect(() => transitionNotificationCandidate({ ...admitted.current, generation: 2 }, admitted.candidate, { outcome: "deliver", reason: "in_app_recorded", now,
      delivery: { notificationId: `notification_${"a".repeat(48)}`, dispositionId: `notification_disposition_${"b".repeat(48)}`, deliveryBindingSha256: "c".repeat(64) } })).toThrow();
    expect(() => admitNotificationCandidate(enabled(), { ...changed.change!, changeSha256: "d".repeat(64) }, fresh, now)).toThrow();
    expect(() => verifyNotificationCandidate({ ...admitted.candidate, actorId: "actor:22222222-2222-4222-8222-222222222222" })).toThrow();
  });
  it("binds immutable receipts to the exact transition and rejects mutations", async () => {
    const head = enabled(); const accepted = buildNotificationReceipt({ previous: null, current: head, key: "enable", request, action: "enable" });
    expect(verifyNotificationReceipt(accepted)).toEqual(accepted);
    expect(() => verifyNotificationReceipt({ ...accepted, snapshot: { ...head, used: 1 } })).toThrow();
    const { changed } = await changes(); const admitted = admitNotificationCandidate(head, changed.change!, fresh, now);
    expect(buildNotificationReceipt({ previous: head, ...admitted, key: "change", request: { changeId: changed.change!.id }, action: "admit" })).toMatchObject({ contentIncluded: false, previousRevision: 1 });
  });
});
